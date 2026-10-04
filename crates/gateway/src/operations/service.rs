use super::{
    CommandSpec, NativeRunner, Runner, absolute, create_private_directory,
    default_runtime_directory, private_metadata, usage, validate_argument,
};
use crate::config;
use anyhow::Context;
use clap::{Args, Subcommand, ValueEnum};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

const UNIT: &str = "agent-connect.service";
const LABEL: &str = "org.agent-connect.gateway";
const MARKER: &str = "Managed by agent-connect service; ACP gateway";

#[derive(Clone, Copy, ValueEnum, Debug, PartialEq, Eq)]
pub enum ServiceManager {
    Systemd,
    Launchd,
}
#[derive(Args)]
pub struct ServiceCli {
    #[arg(long, env = "AGENT_CONNECT_CONFIG", hide_env_values = true)]
    pub config: Option<PathBuf>,
    #[arg(long, value_enum)]
    pub manager: Option<ServiceManager>,
    #[command(subcommand)]
    pub command: ServiceAction,
}
#[derive(Subcommand)]
pub enum ServiceAction {
    /// Install an owned user service without invoking provider login.
    Install {
        /// Generate the definition without contacting or enabling the user manager.
        #[arg(long)]
        offline: bool,
    },
    /// Stop and remove only this gateway's owned user service. Private state is retained.
    Uninstall {
        /// Remove an owned definition without contacting the user manager (stop it first).
        #[arg(long)]
        offline: bool,
    },
    Start,
    Stop,
    Status,
    /// Print bounded recent logs (no follow mode).
    Logs {
        #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u16).range(1..=1000))]
        lines: u16,
    },
}

struct ServicePaths {
    manager: ServiceManager,
    unit: PathBuf,
    config: PathBuf,
    executable: PathBuf,
    logs: PathBuf,
    domain: String,
    search_path: String,
}
impl ServicePaths {
    fn from_cli(cli: &ServiceCli) -> anyhow::Result<Self> {
        let manager = cli.manager.unwrap_or(if cfg!(target_os = "linux") { ServiceManager::Systemd } else if cfg!(target_os = "macos") { ServiceManager::Launchd } else { return Err(usage("user services require Linux systemd or macOS launchd; run serve under your supervisor")); });
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .ok_or_else(|| usage("service management requires an absolute HOME"))?;
        let config = absolute(&cli.config.clone().map(Ok).unwrap_or_else(|| {
            Ok::<_, anyhow::Error>(default_runtime_directory()?.join("config.json"))
        })?)?;
        // Strict private config validation is read-only; service never invents a runtime.
        config::ServeOptions {
            config: Some(config.clone()),
            ..Default::default()
        }
        .resolve()?;
        let config = config.canonicalize()?;
        let unit = match manager {
            ServiceManager::Systemd => {
                let base = std::env::var_os("XDG_CONFIG_HOME")
                    .filter(|p| !p.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".config"));
                anyhow::ensure!(base.is_absolute(), "XDG_CONFIG_HOME must be absolute");
                base.join("systemd/user").join(UNIT)
            }
            ServiceManager::Launchd => home
                .join("Library/LaunchAgents")
                .join(format!("{LABEL}.plist")),
        };
        #[cfg(unix)]
        let domain = format!("gui/{}", unsafe { libc::geteuid() });
        #[cfg(not(unix))]
        let domain = "unsupported".into();
        let executable = std::env::current_exe()?.canonicalize()?;
        let search_path = std::env::var("PATH")
            .map_err(|_| usage("service installation requires a Unicode PATH"))?;
        validate_service_path(&search_path)?;
        let logs = config.parent().unwrap().join("service-logs");
        for path in [&unit, &config, &executable, &logs] {
            validate_argument(&path.to_string_lossy())?;
        }
        Ok(Self {
            manager,
            unit,
            config,
            executable,
            logs,
            domain,
            search_path,
        })
    }
    fn target(&self) -> String {
        format!("{}/{LABEL}", self.domain)
    }
    fn content(&self) -> String {
        match self.manager {
            ServiceManager::Systemd => format!(
                "# {MARKER}\n# Runtime: {}\n[Unit]\nDescription=Agent Connect unstable ACP gateway\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart={} serve --config {}\nEnvironment={}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n",
                self.config.display(),
                systemd_quote(&self.executable),
                systemd_quote(&self.config),
                systemd_environment_quote(&format!("PATH={}", self.search_path))
            ),
            ServiceManager::Launchd => format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<!-- {MARKER} -->\n<!-- Runtime: {} -->\n<plist version=\"1.0\"><dict><key>Label</key><string>{LABEL}</string><key>ProgramArguments</key><array><string>{}</string><string>serve</string><string>--config</string><string>{}</string></array><key>EnvironmentVariables</key><dict><key>PATH</key><string>{}</string></dict><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>RunAtLoad</key><true/><key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string></dict></plist>\n",
                xml(&self.config.to_string_lossy()),
                xml(&self.executable.to_string_lossy()),
                xml(&self.config.to_string_lossy()),
                xml(&self.search_path),
                xml(&self.logs.join("stdout.log").to_string_lossy()),
                xml(&self.logs.join("stderr.log").to_string_lossy())
            ),
        }
    }
    fn verify_owned(&self) -> anyhow::Result<()> {
        private_metadata(&self.unit, false)
            .context("owned service is missing or unsafe; run service install")?;
        let bytes = std::fs::read(&self.unit)?;
        anyhow::ensure!(
            bytes.len() <= 64 * 1024,
            "service definition exceeds size bound"
        );
        let text = String::from_utf8(bytes)?;
        let expected_runtime = match self.manager {
            ServiceManager::Systemd => format!("# Runtime: {}\n", self.config.display()),
            ServiceManager::Launchd => {
                format!("<!-- Runtime: {} -->", xml(&self.config.to_string_lossy()))
            }
        };
        anyhow::ensure!(
            text.contains(MARKER) && text.contains(&expected_runtime),
            "existing service is not owned by this gateway runtime; nothing was changed"
        );
        Ok(())
    }
}

fn validate_service_path(value: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !value.is_empty() && value.len() <= 8192 && !value.chars().any(char::is_control),
        "service PATH must be nonempty, at most 8192 bytes, and contain no control characters"
    );
    let entries = value.split(':').collect::<Vec<_>>();
    anyhow::ensure!(
        entries.len() <= 128
            && entries
                .iter()
                .all(|entry| !entry.is_empty() && Path::new(entry).is_absolute()),
        "service PATH must contain at most 128 absolute directories; remove empty or relative search entries"
    );
    Ok(())
}

fn systemd_environment_quote(value: &str) -> String {
    // Environment= expands specifiers, but does not expand dollar variables.
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    )
}

fn systemd_quote(path: &Path) -> String {
    format!(
        "\"{}\"",
        path.to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$")
    )
}
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
        .replace("--", "&#45;&#45;")
}

pub async fn service(cli: ServiceCli) -> anyhow::Result<()> {
    let output = service_run(cli).await?;
    if !output.is_empty() {
        println!("{output}");
    }
    Ok(())
}
pub(super) async fn service_run(cli: ServiceCli) -> anyhow::Result<String> {
    let paths = ServicePaths::from_cli(&cli)?;
    service_with(&cli.command, &paths, &mut NativeRunner).await
}
pub(super) async fn stop_service_for_upgrade(config: &Path) -> anyhow::Result<()> {
    let paths = ServicePaths::from_cli(&ServiceCli {
        config: Some(config.to_owned()),
        manager: None,
        command: ServiceAction::Status,
    })?;
    stop_installed_for_upgrade(&paths, &mut NativeRunner).await
}
async fn stop_installed_for_upgrade(
    paths: &ServicePaths,
    runner: &mut impl Runner,
) -> anyhow::Result<()> {
    if paths.unit.exists() || paths.unit.is_symlink() {
        paths.verify_owned()?;
        service_with(&ServiceAction::Stop, paths, runner).await?;
    }
    Ok(())
}

async fn run(runner: &mut impl Runner, program: &str, args: &[&str]) -> anyhow::Result<String> {
    let output = runner.run(CommandSpec::new(program, args)).await?;
    output.success("user service manager command failed; ensure a user manager/session is running, or use --no-service and serve under your supervisor")?;
    Ok(output.output)
}

async fn service_with(
    action: &ServiceAction,
    paths: &ServicePaths,
    runner: &mut impl Runner,
) -> anyhow::Result<String> {
    if let ServiceAction::Install { offline } = action {
        let content = paths.content();
        if paths.unit.exists() || paths.unit.is_symlink() {
            paths.verify_owned()?;
            if std::fs::read_to_string(&paths.unit)? != content {
                if paths.manager == ServiceManager::Launchd && !offline {
                    let target = paths.target();
                    let loaded = runner
                        .run(CommandSpec::new("launchctl", ["print", &target]))
                        .await?;
                    if loaded.code == 0 {
                        run(runner, "launchctl", &["bootout", &target]).await?;
                    } else {
                        run(runner, "launchctl", &["print", &paths.domain]).await?;
                    }
                }
                replace_owned_definition(&paths.unit, content.as_bytes())?;
            }
        } else {
            // Check manager availability before installation; failure has no file side effect.
            if !offline {
                match paths.manager {
                    ServiceManager::Systemd => {
                        run(runner, "systemctl", &["--user", "show-environment"]).await?;
                    }
                    ServiceManager::Launchd => {
                        run(runner, "launchctl", &["print", &paths.domain]).await?;
                    }
                }
            }
            create_private_directory(paths.unit.parent().unwrap())?;
            if paths.manager == ServiceManager::Launchd {
                create_private_directory(&paths.logs)?;
                private_metadata(&paths.logs, true)?;
            }
            let mut file = std::fs::OpenOptions::new();
            file.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                file.mode(0o600);
            }
            file.open(&paths.unit)?.write_all(content.as_bytes())?;
        }
        if paths.manager == ServiceManager::Systemd && !offline {
            run(runner, "systemctl", &["--user", "daemon-reload"]).await?;
            run(runner, "systemctl", &["--user", "enable", UNIT]).await?;
        }
        return Ok(format!("Installed user service: {}", paths.unit.display()));
    }
    paths.verify_owned()?;
    let unit_path = paths.unit.to_string_lossy();
    let target = paths.target();
    match (paths.manager, action) {
        (ServiceManager::Systemd, ServiceAction::Start) => {
            run(runner, "systemctl", &["--user", "start", UNIT]).await
        }
        (ServiceManager::Systemd, ServiceAction::Stop) => {
            run(runner, "systemctl", &["--user", "stop", UNIT]).await
        }
        (ServiceManager::Systemd, ServiceAction::Status) => {
            // `show` remains successful when an installed unit is inactive/failed.
            run(
                runner,
                "systemctl",
                &[
                    "--user",
                    "show",
                    UNIT,
                    "--property=LoadState,ActiveState,SubState,ExecMainStatus",
                    "--no-pager",
                ],
            )
            .await
        }
        (ServiceManager::Systemd, ServiceAction::Logs { lines }) => {
            run(
                runner,
                "journalctl",
                &[
                    "--user",
                    "--unit",
                    UNIT,
                    "--lines",
                    &lines.to_string(),
                    "--no-pager",
                    "--output=short-iso",
                ],
            )
            .await
        }
        (ServiceManager::Systemd, ServiceAction::Uninstall { offline }) => {
            if !offline {
                run(runner, "systemctl", &["--user", "disable", "--now", UNIT]).await?;
            }
            std::fs::remove_file(&paths.unit)?;
            if !offline {
                run(runner, "systemctl", &["--user", "daemon-reload"]).await?;
            }
            Ok("Removed owned user service; private runtime and harness home are retained".into())
        }
        (ServiceManager::Launchd, ServiceAction::Start) => {
            let state = runner
                .run(CommandSpec::new("launchctl", ["print", &target]))
                .await?;
            if state.code == 0 {
                run(runner, "launchctl", &["kickstart", &target]).await
            } else {
                run(
                    runner,
                    "launchctl",
                    &["bootstrap", &paths.domain, &unit_path],
                )
                .await
            }
        }
        (ServiceManager::Launchd, ServiceAction::Status) => {
            let state = runner
                .run(CommandSpec::new("launchctl", ["print", &target]))
                .await?;
            if state.code == 0 {
                Ok(state.output)
            } else {
                run(runner, "launchctl", &["print", &paths.domain]).await?;
                Ok("User service is installed and stopped".into())
            }
        }
        (ServiceManager::Launchd, ServiceAction::Stop | ServiceAction::Uninstall { .. }) => {
            if !matches!(action, ServiceAction::Uninstall { offline: true }) {
                let state = runner
                    .run(CommandSpec::new("launchctl", ["print", &target]))
                    .await?;
                if state.code == 0 {
                    run(runner, "launchctl", &["bootout", &target]).await?;
                } else {
                    run(runner, "launchctl", &["print", &paths.domain]).await?;
                }
            }
            if matches!(action, ServiceAction::Uninstall { .. }) {
                std::fs::remove_file(&paths.unit)?;
            }
            Ok("Owned user service stopped; private runtime and harness home are retained".into())
        }
        (ServiceManager::Launchd, ServiceAction::Logs { lines }) => {
            let mut result = String::new();
            for name in ["stdout.log", "stderr.log"] {
                let path = paths.logs.join(name);
                if path.exists() {
                    private_metadata(&path, false)?;
                    result.push_str(
                        &run(
                            runner,
                            "tail",
                            &["-n", &lines.to_string(), "--", &path.to_string_lossy()],
                        )
                        .await?,
                    );
                }
            }
            Ok(result)
        }
        (_, ServiceAction::Install { .. }) => unreachable!(),
    }
}

fn replace_owned_definition(path: &Path, contents: &[u8]) -> anyhow::Result<()> {
    let staging = path.with_file_name(format!(".agent-connect-service-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&staging)?;
        file.write_all(contents)?;
        file.sync_all()?;
        std::fs::rename(&staging, path)?;
        std::fs::File::open(path.parent().unwrap())?.sync_all()?;
        Ok::<_, anyhow::Error>(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::super::CommandOutput;
    use super::*;
    struct Fixture {
        commands: Vec<CommandSpec>,
        code: i32,
    }
    impl Runner for Fixture {
        async fn run(&mut self, command: CommandSpec) -> anyhow::Result<CommandOutput> {
            self.commands.push(command);
            Ok(CommandOutput {
                code: self.code,
                output: "fixture".into(),
            })
        }
    }
    fn paths(manager: ServiceManager) -> ServicePaths {
        let directory = std::env::temp_dir().join(format!("acp-service-{}", uuid::Uuid::new_v4()));
        ServicePaths {
            manager,
            unit: directory.join("unit"),
            config: directory.join("runtime/config.json"),
            executable: "/example/bin/agent-connect".into(),
            logs: directory.join("logs"),
            domain: "gui/123".into(),
            search_path: "/example/package/bin:/example/tools/bin".into(),
        }
    }
    #[tokio::test]
    async fn lifecycle_owns_only_fixed_unit_and_preserves_runtime() {
        let paths = paths(ServiceManager::Systemd);
        let mut fixture = Fixture {
            commands: Vec::new(),
            code: 0,
        };
        service_with(
            &ServiceAction::Install { offline: false },
            &paths,
            &mut fixture,
        )
        .await
        .unwrap();
        let bytes = std::fs::read(&paths.unit).unwrap();
        service_with(
            &ServiceAction::Install { offline: false },
            &paths,
            &mut fixture,
        )
        .await
        .unwrap();
        assert_eq!(bytes, std::fs::read(&paths.unit).unwrap());
        service_with(&ServiceAction::Start, &paths, &mut fixture)
            .await
            .unwrap();
        assert!(
            fixture
                .commands
                .contains(&CommandSpec::new("systemctl", ["--user", "start", UNIT]))
        );
        service_with(&ServiceAction::Logs { lines: 23 }, &paths, &mut fixture)
            .await
            .unwrap();
        assert!(
            fixture
                .commands
                .iter()
                .any(|c| c.program == "journalctl" && c.args.contains(&"23".into()))
        );
        service_with(
            &ServiceAction::Uninstall { offline: false },
            &paths,
            &mut fixture,
        )
        .await
        .unwrap();
        assert!(!paths.unit.exists());
        std::fs::remove_dir_all(paths.unit.parent().unwrap()).unwrap();
    }
    #[tokio::test]
    async fn foreign_unit_and_unavailable_manager_are_never_mutated() {
        let paths = paths(ServiceManager::Systemd);
        let mut fixture = Fixture {
            commands: Vec::new(),
            code: 1,
        };
        assert!(
            service_with(
                &ServiceAction::Install { offline: false },
                &paths,
                &mut fixture
            )
            .await
            .is_err()
        );
        assert!(!paths.unit.exists());
        create_private_directory(paths.unit.parent().unwrap()).unwrap();
        std::fs::write(&paths.unit, "foreign").unwrap();
        fixture.commands.clear();
        assert!(
            service_with(
                &ServiceAction::Uninstall { offline: false },
                &paths,
                &mut fixture
            )
            .await
            .is_err()
        );
        assert!(fixture.commands.is_empty());
        assert_eq!(std::fs::read_to_string(&paths.unit).unwrap(), "foreign");
        std::fs::remove_dir_all(paths.unit.parent().unwrap()).unwrap();
    }
    #[tokio::test]
    async fn launchd_uses_argument_arrays_and_fixed_label() {
        let paths = paths(ServiceManager::Launchd);
        let mut fixture = Fixture {
            commands: Vec::new(),
            code: 0,
        };
        service_with(
            &ServiceAction::Install { offline: false },
            &paths,
            &mut fixture,
        )
        .await
        .unwrap();
        service_with(&ServiceAction::Start, &paths, &mut fixture)
            .await
            .unwrap();
        assert!(fixture.commands.contains(&CommandSpec::new(
            "launchctl",
            ["kickstart", "gui/123/org.agent-connect.gateway"]
        )));
        service_with(&ServiceAction::Stop, &paths, &mut fixture)
            .await
            .unwrap();
        assert!(fixture.commands.contains(&CommandSpec::new(
            "launchctl",
            ["bootout", "gui/123/org.agent-connect.gateway"]
        )));
        std::fs::remove_dir_all(paths.unit.parent().unwrap()).unwrap();
    }
    #[tokio::test]
    async fn offline_install_and_uninstall_never_contact_a_manager() {
        let paths = paths(ServiceManager::Systemd);
        let mut fixture = Fixture {
            commands: Vec::new(),
            code: 1,
        };
        service_with(
            &ServiceAction::Install { offline: true },
            &paths,
            &mut fixture,
        )
        .await
        .unwrap();
        assert!(paths.unit.exists());
        assert!(fixture.commands.is_empty());
        service_with(
            &ServiceAction::Uninstall { offline: true },
            &paths,
            &mut fixture,
        )
        .await
        .unwrap();
        assert!(!paths.unit.exists());
        assert!(fixture.commands.is_empty());
        std::fs::remove_dir_all(paths.unit.parent().unwrap()).unwrap();
    }
    #[tokio::test]
    async fn install_updates_only_a_verified_owned_runtime_definition() {
        let mut paths = paths(ServiceManager::Systemd);
        let mut fixture = Fixture {
            commands: Vec::new(),
            code: 0,
        };
        service_with(
            &ServiceAction::Install { offline: true },
            &paths,
            &mut fixture,
        )
        .await
        .unwrap();
        paths.executable = "/example/new-release/agent-connect".into();
        service_with(
            &ServiceAction::Install { offline: true },
            &paths,
            &mut fixture,
        )
        .await
        .unwrap();
        assert!(
            std::fs::read_to_string(&paths.unit)
                .unwrap()
                .contains("/example/new-release/agent-connect")
        );
        paths.config = paths.config.with_file_name("another-runtime.json");
        assert!(
            service_with(
                &ServiceAction::Install { offline: true },
                &paths,
                &mut fixture
            )
            .await
            .is_err()
        );
        assert!(fixture.commands.is_empty());
        std::fs::remove_dir_all(paths.unit.parent().unwrap()).unwrap();
    }
    #[tokio::test]
    async fn upgrade_restarts_owned_running_service_when_only_executable_changes() {
        struct RunningService {
            commands: Vec<CommandSpec>,
            running: bool,
        }
        impl Runner for RunningService {
            async fn run(&mut self, command: CommandSpec) -> anyhow::Result<CommandOutput> {
                let code = if command.program == "launchctl"
                    && command.args == ["print", "gui/123/org.agent-connect.gateway"]
                    && !self.running
                {
                    1
                } else {
                    0
                };
                if command
                    .args
                    .iter()
                    .any(|arg| matches!(arg.as_str(), "stop" | "bootout"))
                {
                    self.running = false;
                }
                if command
                    .args
                    .iter()
                    .any(|arg| matches!(arg.as_str(), "start" | "bootstrap"))
                {
                    self.running = true;
                }
                self.commands.push(command);
                Ok(CommandOutput {
                    code,
                    output: String::new(),
                })
            }
        }
        for manager in [ServiceManager::Systemd, ServiceManager::Launchd] {
            let mut paths = paths(manager);
            let mut runner = RunningService {
                commands: Vec::new(),
                running: true,
            };
            service_with(
                &ServiceAction::Install { offline: true },
                &paths,
                &mut runner,
            )
            .await
            .unwrap();
            // No image/egress change is required to stop the old gateway process.
            stop_installed_for_upgrade(&paths, &mut runner)
                .await
                .unwrap();
            assert!(!runner.running);
            paths.executable = "/example/upgraded/agent-connect".into();
            service_with(
                &ServiceAction::Install { offline: false },
                &paths,
                &mut runner,
            )
            .await
            .unwrap();
            service_with(&ServiceAction::Start, &paths, &mut runner)
                .await
                .unwrap();
            assert!(runner.running);
            let stop = runner
                .commands
                .iter()
                .position(|command| {
                    command
                        .args
                        .iter()
                        .any(|arg| matches!(arg.as_str(), "stop" | "bootout"))
                })
                .unwrap();
            let start = runner
                .commands
                .iter()
                .position(|command| {
                    command
                        .args
                        .iter()
                        .any(|arg| matches!(arg.as_str(), "start" | "bootstrap"))
                })
                .unwrap();
            assert!(stop < start);
            assert!(
                std::fs::read_to_string(&paths.unit)
                    .unwrap()
                    .contains("/example/upgraded/agent-connect")
            );
            std::fs::remove_dir_all(paths.unit.parent().unwrap()).unwrap();
        }
    }
    #[test]
    fn service_templates_escape_expansions_and_xml() {
        assert_eq!(
            systemd_quote(Path::new("/example/a $b%\"c")),
            "\"/example/a $$b%%\\\"c\""
        );
        assert_eq!(xml("a<&\"'--b"), "a&lt;&amp;&quot;&apos;&#45;&#45;b");
    }
    #[test]
    fn service_path_is_bounded_and_rejects_relative_entries_and_directive_injection() {
        assert!(validate_service_path("/example/package/bin:/example/tools/bin").is_ok());
        for invalid in [
            "",
            ".:/example/bin",
            "/example/bin:",
            ":/example/bin",
            "/example/bin\n[Service]\nExecStart=/example/injected",
            "/example/bin\rPATH=/example/injected",
            "/example/\0bin",
        ] {
            assert!(
                validate_service_path(invalid).is_err(),
                "accepted {invalid:?}"
            );
        }
        assert!(validate_service_path(&format!("/{}", "x".repeat(8192))).is_err());
        assert!(validate_service_path(&vec!["/example/bin"; 129].join(":")).is_err());
    }
    #[test]
    fn managers_preserve_the_validated_installer_path_without_expansion() {
        let path = "/example/tools space/%literal/$literal/\"quoted\"/&<directory>:/example/bin";
        validate_service_path(path).unwrap();
        let mut systemd = paths(ServiceManager::Systemd);
        systemd.search_path = path.into();
        let unit = systemd.content();
        assert!(unit.contains("Environment=\"PATH=/example/tools space/%%literal/$literal/\\\"quoted\\\"/&<directory>:/example/bin\"\n"));
        let mut launchd = paths(ServiceManager::Launchd);
        launchd.search_path = path.into();
        let plist = launchd.content();
        assert!(plist.contains("<key>EnvironmentVariables</key><dict><key>PATH</key><string>/example/tools space/%literal/$literal/&quot;quoted&quot;/&amp;&lt;directory&gt;:/example/bin</string></dict>"));
    }
}
