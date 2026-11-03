//! The container engine the gateway drives, as the engine itself reports it.
//! A rootful engine maps container ids one to one onto the host, so whoever
//! can start containers can start host root. Rootless Docker maps container
//! root onto the invoking user; any other container id is a subordinate id
//! with no access to that user's files. Rootless Podman can map the invoking
//! user onto any container id (`keep-id`). An engine inside a virtual machine
//! (Docker Desktop, OrbStack) is rootful only inside that machine.
use anyhow::{Context, ensure};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// The command the gateway runs for every container operation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, clap::ValueEnum, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Program {
    #[default]
    Docker,
    Podman,
}

static PROGRAM: OnceLock<Program> = OnceLock::new();

/// Fixes the program for this process. Each command's entry point calls it
/// once: the command line or environment first, then the configuration, whose
/// choice is ignored when one was already made. Nothing else selects.
pub fn select(program: Program) {
    let _ = PROGRAM.set(program);
}

/// Whether a program of this name is on PATH.
pub fn installed(name: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(name).is_file()))
}

/// The program chosen so far, if any (the command line, before a config is read).
pub fn chosen() -> Option<Program> {
    PROGRAM.get().copied()
}

pub fn selected() -> Program {
    PROGRAM.get().copied().unwrap_or_default()
}

pub fn program() -> &'static str {
    selected().name()
}

/// The program a command uses: the one its runtime recorded, unless the command
/// line or environment asked for another, which is refused, since the
/// runtime's network proxy and boxes live on its engine. Without a recorded
/// one, the request, else `preferred`.
pub fn runtime_program(
    recorded: Option<Program>,
    requested: Option<Program>,
    preferred: impl FnOnce() -> Program,
) -> anyhow::Result<Program> {
    match (recorded, requested) {
        (Some(recorded), Some(requested)) if recorded != requested => {
            Err(crate::config::UsageError(format!(
                "this runtime uses {recorded:?}; switching engines means editing container_engine in the private configuration, then rerunning setup"
            ))
            .into())
        }
        (Some(program), _) | (None, Some(program)) => Ok(program),
        (None, None) => Ok(preferred()),
    }
}

/// Selects the program for this command from its runtime's recorded one, if
/// it has a runtime. Every command's entry point calls it once it has read its
/// configuration.
pub fn for_runtime(recorded: Option<Program>) -> anyhow::Result<Program> {
    let program = runtime_program(recorded, chosen(), preferred)?;
    select(program);
    Ok(program)
}

/// The program when nothing chose one: the installed engine that runs
/// rootless. Docker when it answers as rootless or in a virtual machine;
/// otherwise Podman, which a user runs rootless, when it is installed;
/// otherwise Docker, whose failure then says what is missing.
pub fn preferred() -> Program {
    static PREFERRED: OnceLock<Program> = OnceLock::new();
    *PREFERRED.get_or_init(|| {
        if !installed("podman") {
            return Program::Docker;
        }
        let docker = installed("docker")
            .then(|| {
                std::process::Command::new("docker")
                    .args(["info", "--format", DOCKER_INFO])
                    .output()
                    .ok()
            })
            .flatten()
            .filter(|output| output.status.success())
            .and_then(|output| parse_docker_info(&String::from_utf8_lossy(&output.stdout)).ok());
        match docker {
            Some(Engine::Rootless | Engine::VirtualMachine) => Program::Docker,
            _ => Program::Podman,
        }
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Rootful,
    Rootless,
    RootlessPodman,
    VirtualMachine,
}

impl Program {
    pub fn name(self) -> &'static str {
        match self {
            Program::Docker => "docker",
            Program::Podman => "podman",
        }
    }

    /// Mount options that give a tmpfs to the container user: Podman 4 rejects
    /// `uid=`/`gid=`, rootful or not, and has `U`, which chowns to whichever
    /// user the box runs as.
    pub fn tmpfs_owner(self, uid: u32, gid: u32) -> String {
        match self {
            Program::Docker => format!("uid={uid},gid={gid}"),
            Program::Podman => "U".into(),
        }
    }
}

const DOCKER_INFO: &str =
    r#"{"securityOptions":{{json .SecurityOptions}},"operatingSystem":{{json .OperatingSystem}}}"#;
const PODMAN_INFO: &str = r#"{"rootless":{{json .Host.Security.Rootless}}}"#;

/// The `info` arguments that `parse_info` reads, for the selected program.
pub fn info_args() -> [&'static str; 3] {
    match selected() {
        Program::Docker => ["info", "--format", DOCKER_INFO],
        Program::Podman => ["info", "--format", PODMAN_INFO],
    }
}

/// The `info` arguments that print the engine's machine architecture.
pub fn architecture_args() -> [&'static str; 3] {
    match selected() {
        Program::Docker => ["info", "--format", "{{.Architecture}}"],
        Program::Podman => ["info", "--format", "{{.Host.Arch}}"],
    }
}

/// Asks the engine, never the CLI context name or `DOCKER_HOST`, which can
/// point anywhere. Fails rather than guessing when the answer is unreadable.
pub fn detect() -> anyhow::Result<Engine> {
    let output = std::process::Command::new(program())
        .args(info_args())
        .output()
        .with_context(|| format!("run {} info", program()))?;
    ensure!(
        output.status.success(),
        "{} info failed; start the container engine and verify `{} info` as your user",
        program(),
        program()
    );
    parse_info(&String::from_utf8_lossy(&output.stdout))
}

pub fn parse_info(output: &str) -> anyhow::Result<Engine> {
    match selected() {
        Program::Docker => parse_docker_info(output),
        Program::Podman => parse_podman_info(output),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DockerInfo {
    security_options: Vec<String>,
    operating_system: String,
}

/// Each security option is a comma-separated field list such as
/// `name=seccomp,profile=builtin`; a rootless daemon lists `name=rootless`.
/// Only the daemon's own report grants the virtual machine pass: a client on
/// macOS can drive a remote rootful Linux daemon. Other VMs (Colima reports its
/// guest's distribution) read as rootful and need the owner's acceptance.
fn parse_docker_info(output: &str) -> anyhow::Result<Engine> {
    let info: DockerInfo = serde_json::from_str(output.trim()).context(
        "unreadable docker info; is this engine Docker? Choose another with --container-engine",
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

#[derive(Deserialize)]
struct PodmanInfo {
    rootless: bool,
}

/// Podman run as root is a rootful engine like any other.
fn parse_podman_info(output: &str) -> anyhow::Result<Engine> {
    let info: PodmanInfo = serde_json::from_str(output.trim()).context("unreadable podman info")?;
    Ok(if info.rootless {
        Engine::RootlessPodman
    } else {
        Engine::Rootful
    })
}

pub const ROOTFUL_RISK: &str = "The container engine is rootful: whatever can start containers on it, this gateway included, can start host root";
pub const ROOTFUL_FIX: &str = "Run rootless Podman or Docker in rootless mode for this user, or record that you accept the risk with agent-connect setup --allow-rootful-engine";

/// Setup's gate. A new runtime on a rootful engine needs the owner's explicit
/// acceptance. An existing one keeps working with a warning, so an upgrade
/// never breaks a gateway that worked before it.
pub fn admit(engine: Engine, accepted: bool, existing: bool) -> anyhow::Result<Option<String>> {
    match (engine, accepted, existing) {
        (Engine::Rootless | Engine::RootlessPodman | Engine::VirtualMachine, ..)
        | (Engine::Rootful, true, _) => Ok(None),
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
        assert_eq!(parse_docker_info(&rootless).unwrap(), Engine::Rootless);
        let rootful = info(
            r#"["name=apparmor","name=seccomp,profile=builtin","name=cgroupns"]"#,
            "Ubuntu 24.04.4 LTS",
        );
        // Whatever the client runs on: a macOS CLI can drive this daemon remotely.
        assert_eq!(parse_docker_info(&rootful).unwrap(), Engine::Rootful);
        let desktop = info(
            r#"["name=seccomp,profile=builtin","name=cgroupns"]"#,
            "Docker Desktop",
        );
        assert_eq!(parse_docker_info(&desktop).unwrap(), Engine::VirtualMachine);
        let orbstack = info(r#"["name=seccomp,profile=builtin"]"#, "OrbStack");
        assert_eq!(
            parse_docker_info(&orbstack).unwrap(),
            Engine::VirtualMachine
        );
        let colima = info(r#"["name=seccomp,profile=builtin"]"#, "Ubuntu 24.04 LTS");
        assert_eq!(parse_docker_info(&colima).unwrap(), Engine::Rootful);
    }

    #[test]
    fn an_existing_runtime_keeps_its_engine() {
        use Program::{Docker, Podman};
        let preferred = || Podman;
        assert_eq!(
            runtime_program(None, Some(Docker), preferred).unwrap(),
            Docker
        );
        assert_eq!(runtime_program(None, None, preferred).unwrap(), Podman);
        assert_eq!(
            runtime_program(Some(Docker), None, preferred).unwrap(),
            Docker
        );
        assert_eq!(
            runtime_program(Some(Podman), Some(Podman), preferred).unwrap(),
            Podman
        );
        assert!(runtime_program(Some(Docker), Some(Podman), preferred).is_err());
        assert!(runtime_program(Some(Podman), Some(Docker), preferred).is_err());
    }

    #[test]
    fn reads_rootless_podman() {
        assert_eq!(
            parse_podman_info(r#"{"rootless":true}"#).unwrap(),
            Engine::RootlessPodman
        );
        assert_eq!(
            parse_podman_info(r#"{"rootless":false}"#).unwrap(),
            Engine::Rootful
        );
        assert!(parse_podman_info(r#"{"rootless":null}"#).is_err());
        assert!(parse_podman_info("").is_err());
    }

    #[test]
    fn refuses_to_guess() {
        assert!(parse_docker_info("").is_err());
        assert!(parse_docker_info("<no value>").is_err());
        assert!(parse_docker_info(r#"{"securityOptions":null}"#).is_err());
        // A field must match exactly, not as a substring.
        assert_eq!(
            parse_docker_info(&info(r#"["name=notrootless"]"#, "Debian")).unwrap(),
            Engine::Rootful
        );
        let remapped = info(r#"["name=apparmor","name=userns"]"#, "Debian");
        assert!(
            parse_docker_info(&remapped)
                .unwrap_err()
                .to_string()
                .contains("userns-remap")
        );
    }
}
