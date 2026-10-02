//! Dedicated shared harness homes. No credential contents are read or copied.
use crate::Harness;
use anyhow::{Context, bail};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct HarnessHome {
    pub path: PathBuf,
    pub uid: u32,
    pub gid: u32,
}

impl HarnessHome {
    pub fn prepare(path: &Path) -> anyhow::Result<Self> {
        if !path.is_absolute() {
            bail!("--harness-home must be an absolute path to a dedicated directory");
        }
        if !path.exists() {
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder
                .create(path)
                .context("create dedicated harness home")?;
        }
        let meta = std::fs::symlink_metadata(path)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            bail!("harness home must be a directory, not a symlink");
        }
        let path = path.canonicalize()?;
        if path.to_string_lossy().contains([',', ':', '\n']) {
            bail!("harness home path contains unsupported mount separators");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.uid() != unsafe { libc::geteuid() } {
                bail!("harness home must be owned by the invoking user");
            }
            if meta.mode() & 0o077 != 0 {
                bail!("harness home must have mode 0700; set its permissions before continuing");
            }
            Ok(Self {
                path,
                uid: meta.uid(),
                gid: meta.gid(),
            })
        }
        #[cfg(not(unix))]
        {
            bail!("shared harness homes currently support Unix hosts only");
        }
    }

    pub fn docker_args(&self) -> Vec<String> {
        vec![
            "--user".into(),
            format!("{}:{}", self.uid, self.gid),
            "--mount".into(),
            format!("type=bind,src={},dst=/home/node", self.path.display()),
        ]
    }
}

/// Login uses the provider's unmodified CLI; the owner operates the terminal.
/// Docker receives only explicitly named, non-credential environment values.
pub fn login_args(home: &HarnessHome, image: &str, harness: Harness) -> Vec<String> {
    let mut args = vec![
        "run".into(),
        "--rm".into(),
        "-it".into(),
        "--cap-drop=ALL".into(),
        "--security-opt=no-new-privileges".into(),
        "-e".into(),
        "HOME=/home/node".into(),
    ];
    args.extend(home.docker_args());
    args.push(image.into());
    args.extend(match harness {
        Harness::Codex => vec!["codex".into(), "login".into(), "--device-auth".into()],
        Harness::Claude => vec!["claude".into(), "/login".into()],
    });
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_home_uses_host_identity_and_private_modes() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let home = HarnessHome::prepare(&dir).unwrap();
        let args = login_args(&home, "session:test", Harness::Codex);
        assert!(args.contains(&format!("{}:{}", home.uid, home.gid)));
        assert!(args.ends_with(&["codex".into(), "login".into(), "--device-auth".into()]));
        assert!(
            !args
                .iter()
                .any(|s| s.contains("API_KEY") || s.contains("OAUTH_TOKEN"))
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(HarnessHome::prepare(&dir).is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_relative_home() {
        assert!(HarnessHome::prepare(Path::new("relative")).is_err());
    }
}
