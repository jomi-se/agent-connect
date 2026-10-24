//! Local box construction: a package-owned base, then one layer with the resolved
//! harness versions and the optional isolated owner layer.
use crate::config::DEFAULT_BOX_IMAGE;
use anyhow::{Context, bail};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

const CODEX_ACP: &str = "@agentclientprotocol/codex-acp";
const CLAUDE_ACP: &str = "@agentclientprotocol/claude-agent-acp";
const CLAUDE_CODE: &str = "@anthropic-ai/claude-code";
const CODEX: &str = "@openai/codex";
// Every package the harness layer installs. Each follows npm's `latest` unless the
// owner pins it, so a new harness release reaches owners without a gateway release.
const HARNESS_PACKAGES: [&str; 4] = [CODEX_ACP, CLAUDE_ACP, CLAUDE_CODE, CODEX];
const NPM_REGISTRY: &str = "https://registry.npmjs.org";
const INSTALL_HARNESSES: &str = "/usr/local/lib/agent-connect/install-harnesses.sh";

/// Exact harness versions by npm package name, as installed in the box layer.
pub type HarnessVersions = BTreeMap<String, String>;

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

// Owner pins from `versions.json`: an exact version or a dist-tag per package.
fn owner_pins(directory: &Path) -> anyhow::Result<BTreeMap<String, String>> {
    let path = directory.join("versions.json");
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let pins: BTreeMap<String, String> = serde_json::from_slice(&fs::read(&path)?)
        .context("versions.json must map package names to versions")?;
    for (name, spec) in &pins {
        anyhow::ensure!(
            HARNESS_PACKAGES.contains(&name.as_str()),
            "versions.json pins {name}; only {} can be pinned",
            HARNESS_PACKAGES.join(", ")
        );
        anyhow::ensure!(
            semver::Version::parse(spec).is_ok() || is_dist_tag(spec),
            "versions.json: {name} must be an exact version such as 1.2.3 or a dist-tag such as latest"
        );
    }
    Ok(pins)
}

fn is_dist_tag(spec: &str) -> bool {
    spec.len() <= 64
        && spec.starts_with(|c: char| c.is_ascii_lowercase())
        && spec.bytes().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

// npm's abbreviated metadata: enough to resolve tags and read dependency ranges.
#[derive(Deserialize)]
struct Packument {
    #[serde(rename = "dist-tags")]
    dist_tags: BTreeMap<String, String>,
    versions: BTreeMap<String, PackageVersion>,
}

#[derive(Deserialize)]
struct PackageVersion {
    #[serde(default)]
    dependencies: BTreeMap<String, String>,
}

impl Packument {
    fn select(&self, name: &str, spec: &str) -> anyhow::Result<String> {
        let version = if semver::Version::parse(spec).is_ok() {
            spec
        } else {
            self.dist_tags
                .get(spec)
                .with_context(|| format!("{name} has no npm dist-tag {spec}"))?
        };
        anyhow::ensure!(
            self.versions.contains_key(version),
            "{name}@{version} is not on npm"
        );
        Ok(version.into())
    }

    // The newest stable release in a caret, tilde or comparison range. npm and Cargo
    // agree on those; anything fancier asks the owner to pin.
    fn newest_matching(&self, name: &str, range: &str) -> anyhow::Result<String> {
        let requirement = semver::VersionReq::parse(range).with_context(|| {
            format!("cannot read the {name} range {range}; pin {name} in versions.json")
        })?;
        self.versions
            .keys()
            .filter_map(|version| semver::Version::parse(version).ok())
            .filter(|version| requirement.matches(version))
            .max()
            .map(|version| version.to_string())
            .with_context(|| format!("no {name} release matches {range}"))
    }
}

async fn packument(client: &reqwest::Client, name: &str) -> anyhow::Result<Packument> {
    let url = format!("{NPM_REGISTRY}/{}", name.replace('/', "%2f"));
    let bytes = client
        .get(url)
        .header("Accept", "application/vnd.npm.install-v1+json")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .with_context(|| format!("look up {name} on npm"))?
        .bytes()
        .await
        .with_context(|| format!("download npm metadata for {name}"))?;
    serde_json::from_slice(&bytes).with_context(|| format!("read npm metadata for {name}"))
}

/// The harness versions the box should carry now: npm's latest, or the owner's pins.
/// Codex is the newest release the chosen codex-acp accepts, since that adapter runs it.
pub(super) async fn resolve_harness() -> anyhow::Result<HarnessVersions> {
    let pins = owner_pins(&owner_directory()?)?;
    let spec = |name: &str| pins.get(name).map_or("latest", String::as_str);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(10))
        .build()?;
    let mut versions = HarnessVersions::new();
    let mut codex_range = None;
    for name in [CODEX_ACP, CLAUDE_ACP, CLAUDE_CODE] {
        let metadata = packument(&client, name).await?;
        let version = metadata.select(name, spec(name))?;
        if name == CODEX_ACP {
            codex_range = metadata.versions[&version].dependencies.get(CODEX).cloned();
        }
        versions.insert(name.into(), version);
    }
    let codex = packument(&client, CODEX).await?;
    let version = match (pins.get(CODEX), codex_range) {
        (Some(pin), _) => codex.select(CODEX, pin)?,
        (None, Some(range)) => codex.newest_matching(CODEX, &range)?,
        (None, None) => codex.select(CODEX, "latest")?,
    };
    versions.insert(CODEX.into(), version);
    Ok(versions)
}

fn test_base_image(value: Option<String>) -> anyhow::Result<String> {
    let Some(image) = value else {
        return Ok(DEFAULT_BOX_IMAGE.into());
    };
    let tag = image.strip_prefix("agent-connect-box-test:");
    anyhow::ensure!(
        tag.is_some_and(|tag| !tag.is_empty()
            && tag.len() <= 111
            && tag.starts_with(|c: char| c.is_ascii_alphanumeric())
            && tag.bytes().all(|c| c.is_ascii_lowercase()
                || c.is_ascii_digit()
                || matches!(c, b'.' | b'_' | b'-'))),
        "AGENT_CONNECT_TEST_BOX_IMAGE must use the agent-connect-box-test namespace"
    );
    Ok(image)
}

fn base_image() -> anyhow::Result<String> {
    let value = std::env::var_os("AGENT_CONNECT_TEST_BOX_IMAGE")
        .map(|value| {
            value
                .into_string()
                .map_err(|_| anyhow::anyhow!("invalid test box image"))
        })
        .transpose()?;
    test_base_image(value)
}

/// The box for these harness versions and the current owner directory.
pub(super) fn desired_image(harness: &HarnessVersions) -> anyhow::Result<String> {
    layer_image(
        &base_image()?,
        harness,
        owner_hash(&owner_directory()?)?.as_deref(),
    )
}

// One tag per base, harness set and owner layer, so any change rebuilds and an
// unchanged selection reuses the installed box.
fn layer_image(
    base: &str,
    harness: &HarnessVersions,
    owner: Option<&str>,
) -> anyhow::Result<String> {
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(harness)?);
    hash.update([0]);
    hash.update(owner.unwrap_or_default());
    Ok(format!(
        "{base}-{}",
        &format!("{:x}", hash.finalize())[..16]
    ))
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
    target: Option<&str>,
    image: &str,
    platform: &str,
) -> anyhow::Result<()> {
    eprintln!(
        "Building {image} locally for {platform} from the gateway package (about 1 GB; owner tools add to this). Build steps have normal network access."
    );
    let status = tokio::process::Command::new("docker")
        .args(["build", "--platform", platform, "--tag", image])
        .args(
            target
                .map(|target| ["--target", target])
                .into_iter()
                .flatten(),
        )
        .arg("--file")
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

async fn build_selected(selected: &str, harness: &HarnessVersions) -> anyhow::Result<()> {
    let base_image = base_image()?;
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
    if !installed(&base_image).await? {
        let base = scratch.0.join("base");
        copy_directory(&context, &base).context("box build context is missing; install the gateway launcher and matching platform package")?;
        fs::copy(&runner, base.join("session-runner"))
            .context("matching Linux session-runner is missing from the platform package")?;
        build(
            &base,
            &base.join("Dockerfile"),
            Some("base"),
            &base_image,
            platform,
        )
        .await?;
    }
    let owner = owner_directory()?;
    let snapshot = scratch.0.join("owner");
    let lines = if owner.join("Dockerfile").exists() {
        copy_directory(&owner, &snapshot)?;
        fs::read_to_string(snapshot.join("Dockerfile"))?
    } else {
        fs::create_dir(&snapshot)?;
        String::new()
    };
    anyhow::ensure!(
        layer_image(&base_image, harness, owner_hash(&snapshot)?.as_deref())? == selected,
        "owner box directory changed during setup; rerun setup"
    );
    // Exec form with a JSON string argument: no shell quoting of the versions.
    let versions = serde_json::to_string(&serde_json::to_string(harness)?)?;
    let wrapper = scratch.0.join("Dockerfile.layer");
    fs::write(
        &wrapper,
        format!(
            "FROM {base_image}\nUSER root\nRUN [\"sh\", \"{INSTALL_HARNESSES}\", {versions}]\n{lines}\nUSER node\nWORKDIR /work\nENTRYPOINT [\"/usr/local/bin/entrypoint.sh\"]\n"
        ),
    )?;
    build(&snapshot, &wrapper, None, selected, platform).await
}

pub(super) async fn ensure_box(
    selected: &str,
    previous: Option<&str>,
    harness: Option<&HarnessVersions>,
) -> anyhow::Result<String> {
    if installed(selected).await? {
        eprintln!("Reusing local box {selected}.");
        return Ok(selected.into());
    }
    let Some(harness) = harness else {
        bail!("box {selected} is missing, and npm could not be reached to choose harness versions");
    };
    match build_selected(selected, harness).await {
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

// The previous selection and its package base, when they belong to this
// gateway's box repository and the new selection no longer uses them.
fn superseded_images(previous: &str, selected: &str, base: &str) -> Vec<String> {
    let repository = base.split_once(':').map_or(base, |(name, _)| name);
    let Some(tag) = previous.strip_prefix(&format!("{repository}:")) else {
        return Vec::new();
    };
    let previous_base = match tag.rsplit_once('-') {
        Some((version, hash))
            if hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_hexdigit()) =>
        {
            format!("{repository}:{version}")
        }
        _ => previous.to_owned(),
    };
    let mut images = vec![previous.to_owned()];
    if previous_base != previous {
        images.push(previous_base);
    }
    images.retain(|image| image != selected && image != base);
    images
}

/// Tell the owner which boxes an upgrade left unused. Removing them is the
/// owner's decision, like any other Docker image.
pub(super) async fn report_superseded(previous: &str, selected: &str) -> anyhow::Result<()> {
    for image in superseded_images(previous, selected, &base_image()?) {
        if installed(&image).await? {
            eprintln!(
                "Previous box {image} is no longer used; `docker image rm {image}` frees its space."
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrades_report_only_replaced_boxes_from_this_repository() {
        let base = "agent-connect-box:0.0.3";
        let owned = "agent-connect-box:0.0.3-0123456789abcdef";
        assert_eq!(
            superseded_images("agent-connect-box:0.0.2", base, base),
            ["agent-connect-box:0.0.2"]
        );
        assert_eq!(
            superseded_images("agent-connect-box:0.0.2-fedcba9876543210", owned, base),
            [
                "agent-connect-box:0.0.2-fedcba9876543210",
                "agent-connect-box:0.0.2"
            ]
        );
        // A changed owner layer keeps the shared package base.
        assert_eq!(
            superseded_images("agent-connect-box:0.0.3-fedcba9876543210", owned, base),
            ["agent-connect-box:0.0.3-fedcba9876543210"]
        );
        assert_eq!(superseded_images(owned, base, base), [owned]);
        assert!(superseded_images(base, base, base).is_empty());
        for foreign in ["example/box:0.0.2", "agent-connect-box-test:0.0.2"] {
            assert!(
                superseded_images(foreign, base, base).is_empty(),
                "{foreign}"
            );
        }
    }
    #[test]
    fn test_image_override_cannot_select_installed_gateway_tags() {
        assert_eq!(test_base_image(None).unwrap(), DEFAULT_BOX_IMAGE);
        let image = "agent-connect-box-test:0.0.1-run123";
        assert_eq!(test_base_image(Some(image.into())).unwrap(), image);
        for invalid in [
            "agent-connect-box:0.0.1",
            "agent-connect-session:0.0.1",
            "agent-connect-box-test:",
            "agent-connect-box-test:-bad",
            "agent-connect-box-test:bad/tag",
            "agent-connect-box-test:BAD",
        ] {
            assert!(test_base_image(Some(invalid.into())).is_err(), "{invalid}");
        }
    }

    #[test]
    fn harness_versions_follow_tags_pins_and_the_adapter_codex_range() {
        let metadata: Packument = serde_json::from_value(serde_json::json!({
            "dist-tags": { "latest": "0.160.1", "next": "0.161.0-alpha.1" },
            "versions": {
                "0.159.2": {}, "0.160.0": {}, "0.160.1": {},
                "0.161.0-alpha.1": {}, "0.164.0": {}
            }
        }))
        .unwrap();
        assert_eq!(metadata.select(CODEX, "latest").unwrap(), "0.160.1");
        assert_eq!(metadata.select(CODEX, "next").unwrap(), "0.161.0-alpha.1");
        assert_eq!(metadata.select(CODEX, "0.159.2").unwrap(), "0.159.2");
        assert!(metadata.select(CODEX, "0.1.0").is_err());
        assert!(metadata.select(CODEX, "beta").is_err());
        // npm and Cargo read 0.x carets alike: patch releases only.
        assert_eq!(
            metadata.newest_matching(CODEX, "^0.160.0").unwrap(),
            "0.160.1"
        );
        assert_eq!(
            metadata.newest_matching(CODEX, ">=0.159.0").unwrap(),
            "0.164.0"
        );
        assert!(metadata.newest_matching(CODEX, "^0.162.0").is_err());
    }

    #[test]
    fn owner_pins_accept_exact_versions_and_tags_for_known_packages_only() {
        let scratch = Scratch::new().unwrap();
        assert!(owner_pins(&scratch.0).unwrap().is_empty());
        let pins = scratch.0.join("versions.json");
        fs::write(
            &pins,
            r#"{"@openai/codex":"0.159.2","@anthropic-ai/claude-code":"stable"}"#,
        )
        .unwrap();
        assert_eq!(owner_pins(&scratch.0).unwrap().len(), 2);
        for invalid in [
            r#"{"left-pad":"1.0.0"}"#,
            r#"{"@openai/codex":"^0.159.0"}"#,
            r#"{"@openai/codex":"0.159.2; rm -rf /"}"#,
            r#"["@openai/codex"]"#,
        ] {
            fs::write(&pins, invalid).unwrap();
            assert!(owner_pins(&scratch.0).is_err(), "{invalid}");
        }
    }

    #[test]
    fn box_tag_changes_with_any_harness_version_or_owner_layer() {
        let base = "agent-connect-box:0.0.4";
        let harness: HarnessVersions = [(CODEX.to_owned(), "0.160.1".to_owned())].into();
        let first = layer_image(base, &harness, None).unwrap();
        assert_eq!(first, layer_image(base, &harness, None).unwrap());
        assert!(first.starts_with("agent-connect-box:0.0.4-") && first.len() == base.len() + 17);
        let newer: HarnessVersions = [(CODEX.to_owned(), "0.160.2".to_owned())].into();
        assert_ne!(first, layer_image(base, &newer, None).unwrap());
        assert_ne!(first, layer_image(base, &harness, Some("owner")).unwrap());
    }

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
