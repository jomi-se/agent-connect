//! Local box construction from package-owned inputs and an optional isolated owner layer.
use crate::config::DEFAULT_BOX_IMAGE;
use anyhow::{Context, bail};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
};

pub(super) fn owner_directory() -> anyhow::Result<PathBuf> {
    let root = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .context("set HOME or XDG_CONFIG_HOME for the owner box directory")?;
    anyhow::ensure!(root.is_absolute(), "XDG config root must be absolute");
    Ok(root.join("agent-connect/box"))
}

// Include names, file bytes and executable modes. Reject links/special files so COPY
// cannot follow an owner-context link into gateway state. Empty directories count too.
fn hash_directory(root: &Path) -> anyhow::Result<String> {
    fn visit(root: &Path, path: &Path, hash: &mut Sha256) -> anyhow::Result<()> {
        let metadata = fs::symlink_metadata(path)?;
        anyhow::ensure!(
            metadata.is_file() || metadata.is_dir(),
            "box context must contain only regular files and directories"
        );
        let name = path.strip_prefix(root)?.as_os_str().as_encoded_bytes();
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            hash.update((metadata.permissions().mode() & 0o777).to_le_bytes());
        }
        hash.update([u8::from(metadata.is_dir())]);
        if metadata.is_dir() {
            let mut entries = fs::read_dir(path)?
                .map(|entry| entry.map(|e| e.path()))
                .collect::<Result<Vec<_>, _>>()?;
            entries.sort();
            for entry in entries {
                visit(root, &entry, hash)?;
            }
        } else {
            let bytes = fs::read(path)?;
            hash.update((bytes.len() as u64).to_le_bytes());
            hash.update(bytes);
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    visit(root, root, &mut hash)?;
    Ok(format!("{:x}", hash.finalize()))
}

fn owner_hash(directory: &Path) -> anyhow::Result<Option<String>> {
    if !directory.join("Dockerfile").exists() {
        return Ok(None);
    }
    let lines = fs::read_to_string(directory.join("Dockerfile"))?;
    for line in lines.lines() {
        let instruction = line
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        anyhow::ensure!(
            !matches!(
                instruction.as_str(),
                "FROM" | "USER" | "ENTRYPOINT" | "ONBUILD"
            ),
            "owner Dockerfile must not contain FROM, USER, ENTRYPOINT or ONBUILD"
        );
    }
    Ok(Some(hash_directory(directory)?))
}

pub(super) fn desired_image() -> anyhow::Result<String> {
    Ok(match owner_hash(&owner_directory()?)? {
        Some(hash) => format!("{DEFAULT_BOX_IMAGE}-{}", &hash[..16]),
        None => DEFAULT_BOX_IMAGE.into(),
    })
}

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> anyhow::Result<Self> {
        let path = std::env::temp_dir().join(format!("agent-connect-box-{}", uuid::Uuid::new_v4()));
        super::create_private_directory(&path)?;
        Ok(Self(path))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn copy_directory(source: &Path, destination: &Path) -> anyhow::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    anyhow::ensure!(metadata.is_dir(), "box context must be a regular directory");
    fs::create_dir(destination)?;
    fs::set_permissions(destination, metadata.permissions())?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let dest = destination.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_directory(&entry.path(), &dest)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), dest)?;
        } else {
            bail!("box context must contain only regular files and directories");
        }
    }
    Ok(())
}

async fn installed(image: &str) -> anyhow::Result<bool> {
    let status = tokio::process::Command::new("docker")
        .args(["image", "inspect", image])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await?;
    Ok(status.success())
}

async fn build(
    context: &Path,
    dockerfile: &Path,
    image: &str,
    platform: &str,
) -> anyhow::Result<()> {
    eprintln!(
        "Building {image} locally for {platform} from the gateway package (about 1 GB; owner tools add to this). Build steps have normal network access."
    );
    let status = tokio::process::Command::new("docker")
        .args(["build", "--platform", platform, "--tag", image, "--file"])
        .arg(dockerfile)
        .arg(context)
        .stdin(Stdio::null())
        .stdout(Stdio::from(std::io::stderr()))
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .status()
        .await
        .context("run Docker box build")?;
    anyhow::ensure!(status.success(), "Docker box build failed ({status})");
    Ok(())
}

async fn build_selected(selected: &str) -> anyhow::Result<()> {
    let architecture = tokio::process::Command::new("docker")
        .args(["info", "--format", "{{.Architecture}}"])
        .output()
        .await
        .context("inspect Docker architecture")?;
    anyhow::ensure!(
        architecture.status.success(),
        "Docker is unavailable; start Docker before setup"
    );
    let platform = match String::from_utf8(architecture.stdout)?.trim() {
        "aarch64" | "arm64" => "linux/arm64",
        "x86_64" | "amd64" => "linux/amd64",
        _ => bail!("unsupported Docker architecture"),
    };
    let expected = if cfg!(target_arch = "aarch64") {
        "linux/arm64"
    } else {
        "linux/amd64"
    };
    anyhow::ensure!(
        platform == expected,
        "Docker architecture must match the installed platform package"
    );
    let executable = std::env::current_exe()?;
    let context = std::env::var_os("AGENT_CONNECT_BOX_CONTEXT")
        .map(PathBuf::from)
        .unwrap_or_else(|| executable.parent().unwrap().join("box"));
    let runner = executable.parent().unwrap().join("session-runner");
    let scratch = Scratch::new()?;
    if !installed(DEFAULT_BOX_IMAGE).await? {
        let base = scratch.0.join("base");
        copy_directory(&context, &base).context("box build context is missing; install the gateway launcher and matching platform package")?;
        fs::copy(&runner, base.join("session-runner"))
            .context("matching Linux session-runner is missing from the platform package")?;
        build(&base, &base.join("Dockerfile"), DEFAULT_BOX_IMAGE, platform).await?;
    }
    if selected != DEFAULT_BOX_IMAGE {
        let owner = owner_directory()?;
        let snapshot = scratch.0.join("owner");
        copy_directory(&owner, &snapshot)?;
        anyhow::ensure!(
            owner_hash(&snapshot)?
                .map(|hash| format!("{DEFAULT_BOX_IMAGE}-{}", &hash[..16]))
                .as_deref()
                == Some(selected),
            "owner box directory changed during setup; rerun setup"
        );
        let lines = fs::read_to_string(snapshot.join("Dockerfile"))?;
        let wrapper = scratch.0.join("Dockerfile.owner");
        fs::write(
            &wrapper,
            format!(
                "FROM {DEFAULT_BOX_IMAGE}\nUSER root\n{lines}\nUSER node\nWORKDIR /work\nENTRYPOINT [\"/usr/local/bin/entrypoint.sh\"]\n"
            ),
        )?;
        build(&snapshot, &wrapper, selected, platform).await?;
    }
    Ok(())
}

pub(super) async fn ensure_box(selected: &str, previous: Option<&str>) -> anyhow::Result<String> {
    if installed(selected).await? {
        eprintln!("Reusing local box {selected}.");
        return Ok(selected.into());
    }
    match build_selected(selected).await {
        Ok(()) => Ok(selected.into()),
        Err(error) => {
            if let Some(previous) = previous {
                if installed(previous).await? {
                    eprintln!(
                        "{error:#}\nKeeping previously built box {previous} in use; run agent-connect setup to retry."
                    );
                    return Ok(previous.into());
                }
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn layer_hash_tracks_contents_names_modes_and_rejects_escape_links() {
        let scratch = Scratch::new().unwrap();
        let root = scratch.0.join("owner");
        fs::create_dir(&root).unwrap();
        assert_eq!(owner_hash(&root).unwrap(), None);
        fs::write(root.join("Dockerfile"), "RUN true\n").unwrap();
        let first = owner_hash(&root).unwrap();
        fs::write(root.join("tool"), "one").unwrap();
        let second = owner_hash(&root).unwrap();
        assert_ne!(first, second);
        fs::write(root.join("tool"), "two").unwrap();
        assert_ne!(second, owner_hash(&root).unwrap());
        fs::write(root.join("Dockerfile"), "from another-image\n").unwrap();
        assert!(owner_hash(&root).is_err());
        fs::write(root.join("Dockerfile"), "RUN true\n").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/", root.join("escape")).unwrap();
            assert!(owner_hash(&root).is_err());
        }
    }
}
