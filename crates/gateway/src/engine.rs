//! The container engine behind the `docker` command, as the daemon reports it.
//! A rootful engine maps container ids one to one onto the host, so whoever
//! can start containers can start host root. A rootless engine maps container
//! root onto the invoking user; any other container id is a subordinate id
//! with no access to that user's files.
use anyhow::{Context, ensure};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Rootful,
    Rootless,
}

/// Asks the daemon, never the CLI context name or `DOCKER_HOST`, which can
/// point anywhere. Fails rather than guessing when the answer is unreadable.
pub fn detect() -> anyhow::Result<Engine> {
    let output = std::process::Command::new("docker")
        .args(["info", "--format", "{{json .SecurityOptions}}"])
        .output()
        .context("run docker info")?;
    ensure!(
        output.status.success(),
        "docker info failed; start Docker and verify docker info as your user"
    );
    parse_security_options(&String::from_utf8_lossy(&output.stdout))
}

/// Each option is a comma-separated field list such as
/// `name=seccomp,profile=builtin`; a rootless daemon lists `name=rootless`.
pub fn parse_security_options(json: &str) -> anyhow::Result<Engine> {
    let options: Vec<String> =
        serde_json::from_str(json.trim()).context("unreadable docker security options")?;
    let rootless = options
        .iter()
        .any(|option| option.split(',').any(|field| field == "name=rootless"));
    Ok(if rootless {
        Engine::Rootless
    } else {
        Engine::Rootful
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_rootless_from_the_daemon_options() {
        let rootless = r#"["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]"#;
        assert_eq!(parse_security_options(rootless).unwrap(), Engine::Rootless);
        let rootful = r#"["name=apparmor","name=seccomp,profile=builtin","name=cgroupns"]"#;
        assert_eq!(parse_security_options(rootful).unwrap(), Engine::Rootful);
    }

    #[test]
    fn refuses_to_guess() {
        assert!(parse_security_options("").is_err());
        assert!(parse_security_options("<no value>").is_err());
        // A field must match exactly, not as a substring.
        assert_eq!(
            parse_security_options(r#"["name=notrootless"]"#).unwrap(),
            Engine::Rootful
        );
    }
}
