//! The container engine behind the `docker` command, as the daemon reports it.
//! A rootful engine maps container ids one to one onto the host, so whoever
//! can start containers can start host root. A rootless engine maps container
//! root onto the invoking user; any other container id is a subordinate id
//! with no access to that user's files. An engine inside a virtual machine
//! (Docker Desktop, OrbStack) is rootful only inside that machine.
use anyhow::{Context, ensure};
use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Rootful,
    Rootless,
    VirtualMachine,
}

/// `docker info` output that `parse_info` reads.
pub const INFO_FORMAT: &str =
    r#"{"securityOptions":{{json .SecurityOptions}},"operatingSystem":{{json .OperatingSystem}}}"#;

/// Asks the daemon, never the CLI context name or `DOCKER_HOST`, which can
/// point anywhere. Fails rather than guessing when the answer is unreadable.
pub fn detect() -> anyhow::Result<Engine> {
    let output = std::process::Command::new("docker")
        .args(["info", "--format", INFO_FORMAT])
        .output()
        .context("run docker info")?;
    ensure!(
        output.status.success(),
        "docker info failed; start Docker and verify docker info as your user (other engines behind a docker command are not supported yet)"
    );
    parse_info(&String::from_utf8_lossy(&output.stdout))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    security_options: Vec<String>,
    operating_system: String,
}

/// Each security option is a comma-separated field list such as
/// `name=seccomp,profile=builtin`; a rootless daemon lists `name=rootless`.
/// Only the daemon's own report grants the virtual machine pass: a client on
/// macOS can drive a remote rootful Linux daemon. Other VMs (Colima reports its
/// guest's distribution) read as rootful and need the owner's acceptance.
pub fn parse_info(output: &str) -> anyhow::Result<Engine> {
    let info: Info = serde_json::from_str(output.trim()).context(
        "unreadable docker info; is this engine Docker? Other engines are not supported yet",
    )?;
    let has = |name: &str| {
        info.security_options
            .iter()
            .any(|option| option.split(',').any(|field| field == name))
    };
    // A remapped daemon shifts every container id, root included, so neither
    // the owner's uid nor container root owns the mounted home there.
    ensure!(
        !has("name=userns"),
        "Docker's userns-remap mode is not supported; use rootless mode instead"
    );
    Ok(if has("name=rootless") {
        Engine::Rootless
    } else if matches!(
        info.operating_system.as_str(),
        "Docker Desktop" | "OrbStack"
    ) {
        Engine::VirtualMachine
    } else {
        Engine::Rootful
    })
}

pub const ROOTFUL_RISK: &str = "The container engine is rootful: whatever can start containers on it, this gateway included, can start host root";
pub const ROOTFUL_FIX: &str = "Run Docker in rootless mode for this user, or record that you accept the risk with agent-connect setup --allow-rootful-engine";

/// Setup's gate. A new runtime on a rootful engine needs the owner's explicit
/// acceptance. An existing one keeps working with a warning, so an upgrade
/// never breaks a gateway that worked before it.
pub fn admit(engine: Engine, accepted: bool, existing: bool) -> anyhow::Result<Option<String>> {
    match (engine, accepted, existing) {
        (Engine::Rootless | Engine::VirtualMachine, ..) | (Engine::Rootful, true, _) => Ok(None),
        (Engine::Rootful, false, true) => Ok(Some(format!("{ROOTFUL_RISK}.\n{ROOTFUL_FIX}."))),
        (Engine::Rootful, false, false) => {
            Err(crate::config::UsageError(format!("{ROOTFUL_RISK}. {ROOTFUL_FIX}.")).into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_runtime_needs_the_owner_to_accept_a_rootful_engine() {
        assert!(admit(Engine::Rootful, false, false).is_err());
        assert_eq!(admit(Engine::Rootful, true, false).unwrap(), None);
        assert_eq!(admit(Engine::Rootless, false, false).unwrap(), None);
        assert_eq!(admit(Engine::VirtualMachine, false, false).unwrap(), None);
    }

    #[test]
    fn an_existing_runtime_keeps_working_with_a_warning() {
        let warning = admit(Engine::Rootful, false, true).unwrap().unwrap();
        assert!(warning.contains("host root"));
        assert!(warning.contains("--allow-rootful-engine"));
        assert_eq!(admit(Engine::Rootful, true, true).unwrap(), None);
    }

    fn info(options: &str, os: &str) -> String {
        format!(r#"{{"securityOptions":{options},"operatingSystem":"{os}"}}"#)
    }

    #[test]
    fn reads_the_engine_from_the_daemon() {
        let rootless = info(
            r#"["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]"#,
            "Ubuntu 24.04.4 LTS",
        );
        assert_eq!(parse_info(&rootless).unwrap(), Engine::Rootless);
        let rootful = info(
            r#"["name=apparmor","name=seccomp,profile=builtin","name=cgroupns"]"#,
            "Ubuntu 24.04.4 LTS",
        );
        // Whatever the client runs on: a macOS CLI can drive this daemon remotely.
        assert_eq!(parse_info(&rootful).unwrap(), Engine::Rootful);
        let desktop = info(
            r#"["name=seccomp,profile=builtin","name=cgroupns"]"#,
            "Docker Desktop",
        );
        assert_eq!(parse_info(&desktop).unwrap(), Engine::VirtualMachine);
        let orbstack = info(r#"["name=seccomp,profile=builtin"]"#, "OrbStack");
        assert_eq!(parse_info(&orbstack).unwrap(), Engine::VirtualMachine);
        let colima = info(r#"["name=seccomp,profile=builtin"]"#, "Ubuntu 24.04 LTS");
        assert_eq!(parse_info(&colima).unwrap(), Engine::Rootful);
    }

    #[test]
    fn refuses_to_guess() {
        assert!(parse_info("").is_err());
        assert!(parse_info("<no value>").is_err());
        assert!(parse_info(r#"{"securityOptions":null}"#).is_err());
        // A field must match exactly, not as a substring.
        assert_eq!(
            parse_info(&info(r#"["name=notrootless"]"#, "Debian")).unwrap(),
            Engine::Rootful
        );
        let remapped = info(r#"["name=apparmor","name=userns"]"#, "Debian");
        assert!(
            parse_info(&remapped)
                .unwrap_err()
                .to_string()
                .contains("userns-remap")
        );
    }
}
