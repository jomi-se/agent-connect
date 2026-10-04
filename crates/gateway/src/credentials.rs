//! Dedicated shared harness homes. No credential contents are read or copied.
use crate::Harness;
use anyhow::{Context, bail};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

/// A dedicated whole home per harness, never the provider's personal home.
pub fn default_home(harness: Harness) -> anyhow::Result<PathBuf> {
    default_home_from(
        harness,
        cfg!(target_os = "macos"),
        std::env::var_os("HOME").map(PathBuf::from),
        std::env::var_os("XDG_STATE_HOME").map(PathBuf::from),
    )
}

fn default_home_from(
    harness: Harness,
    macos: bool,
    home: Option<PathBuf>,
    state: Option<PathBuf>,
) -> anyhow::Result<PathBuf> {
    let base = if let Some(state) = state.filter(|path| !path.as_os_str().is_empty()) {
        state
    } else {
        let home = home
            .filter(|path| !path.as_os_str().is_empty())
            .ok_or_else(|| {
                crate::config::UsageError("set HOME, XDG_STATE_HOME or --harness-home".into())
            })?;
        if macos {
            home.join("Library/Application Support")
        } else {
            home.join(".local/state")
        }
    };
    if !base.is_absolute() {
        return Err(crate::config::UsageError(
            "HOME and XDG_STATE_HOME must be absolute paths".into(),
        )
        .into());
    }
    Ok(base.join("agent-connect/harnesses").join(match harness {
        Harness::Codex => "codex",
        Harness::Claude => "claude",
    }))
}

/// The shipped session image sets CODEX_HOME and CLAUDE_CONFIG_DIR under the
/// mounted whole home. Inspect metadata only; never open credential contents.
pub fn credential_file_present(home: &Path, harness: Harness) -> bool {
    home.join(match harness {
        Harness::Codex => "codex-home/auth.json",
        Harness::Claude => "claude-config/.credentials.json",
    })
    .symlink_metadata()
    .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

/// A small terminal selector; EOF or q cancels before creating a home.
pub fn select_harness(
    input: &mut impl BufRead,
    output: &mut impl Write,
    default: Harness,
) -> anyhow::Result<Option<Harness>> {
    writeln!(
        output,
        "Choose a harness:\n  1) Codex\n  2) Claude Code (unconfirmed against Anthropic terms)"
    )?;
    loop {
        write!(
            output,
            "Selection [{}], or q to cancel: ",
            match default {
                Harness::Codex => "1",
                Harness::Claude => "2",
            }
        )?;
        output.flush()?;
        let mut answer = String::new();
        if input.read_line(&mut answer)? == 0 {
            return Ok(None);
        }
        match answer.trim().to_ascii_lowercase().as_str() {
            "" => return Ok(Some(default)),
            "1" | "codex" => return Ok(Some(Harness::Codex)),
            "2" | "claude" => return Ok(Some(Harness::Claude)),
            "q" | "quit" => return Ok(None),
            _ => writeln!(output, "Enter 1 for Codex or 2 for Claude Code.")?,
        }
    }
}

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
    fn convention_homes_are_per_harness_and_platform_with_explicit_state_override() {
        let home = Some(PathBuf::from("/example/user"));
        assert_eq!(
            default_home_from(Harness::Codex, false, home.clone(), None).unwrap(),
            Path::new("/example/user/.local/state/agent-connect/harnesses/codex")
        );
        assert_eq!(
            default_home_from(Harness::Claude, true, home.clone(), None).unwrap(),
            Path::new("/example/user/Library/Application Support/agent-connect/harnesses/claude")
        );
        assert_eq!(
            default_home_from(Harness::Codex, true, None, Some("/example/state".into())).unwrap(),
            Path::new("/example/state/agent-connect/harnesses/codex")
        );
        assert!(default_home_from(Harness::Codex, false, None, None).is_err());
        assert!(default_home_from(Harness::Codex, false, home, Some("relative".into())).is_err());
    }

    #[test]
    fn login_detection_matches_shipped_image_homes_without_reading_credentials() {
        let entrypoint = include_str!("../../../deploy/gateway/session/entrypoint.sh");
        assert!(entrypoint.contains("CODEX_HOME=\"$HOME/codex-home\""));
        assert!(entrypoint.contains("CLAUDE_CONFIG_DIR=\"$HOME/claude-config\""));
        let root =
            std::env::temp_dir().join(format!("acp-login-metadata-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("codex-home")).unwrap();
        std::fs::create_dir_all(root.join("claude-config")).unwrap();
        assert!(!credential_file_present(&root, Harness::Codex));
        assert!(!credential_file_present(&root, Harness::Claude));
        // Empty files test presence, without placing any credentials in a fixture.
        std::fs::write(root.join("codex-home/auth.json"), []).unwrap();
        assert!(credential_file_present(&root, Harness::Codex));
        assert!(!credential_file_present(&root, Harness::Claude));
        std::fs::write(root.join("claude-config/.credentials.json"), []).unwrap();
        assert!(credential_file_present(&root, Harness::Claude));
        std::fs::remove_file(root.join("codex-home/auth.json")).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                root.join("claude-config/.credentials.json"),
                root.join("codex-home/auth.json"),
            )
            .unwrap();
            assert!(!credential_file_present(&root, Harness::Codex));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selector_defaults_validates_and_cancels_before_login() {
        let mut output = Vec::new();
        assert!(matches!(
            select_harness(&mut &b"\n"[..], &mut output, Harness::Codex).unwrap(),
            Some(Harness::Codex)
        ));
        assert!(matches!(
            select_harness(&mut &b"invalid\n2\n"[..], &mut output, Harness::Codex).unwrap(),
            Some(Harness::Claude)
        ));
        assert!(matches!(
            select_harness(&mut &b"\n"[..], &mut output, Harness::Claude).unwrap(),
            Some(Harness::Claude)
        ));
        assert!(
            select_harness(&mut &b"q\n"[..], &mut output, Harness::Codex)
                .unwrap()
                .is_none()
        );
        assert!(
            select_harness(&mut &b""[..], &mut output, Harness::Codex)
                .unwrap()
                .is_none()
        );
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("Codex"));
        assert!(text.contains("unconfirmed against Anthropic terms"));
        assert!(text.contains("Enter 1"));
    }
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
