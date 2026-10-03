//! Owner-run installation and read-only diagnostics. No provider secrets are inspected.
mod doctor;
mod service;
pub use doctor::{Check, CheckStatus, DoctorCli, DoctorReport, doctor, doctor_report};
pub use service::{ServiceAction, ServiceCli, ServiceManager, service};

use crate::policy::PermissionProfile;
use crate::{Harness, config, credentials};
use anyhow::{Context, bail};
use clap::Args;
use serde::Serialize;
use std::{
    io::{BufRead, IsTerminal, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncReadExt;

#[derive(Args)]
pub struct SetupCli {
    /// Private runtime directory (defaults to the platform Agent Connect state directory).
    #[arg(long)]
    pub directory: Option<PathBuf>,
    #[arg(long, value_enum)]
    pub harness: Option<Harness>,
    #[arg(long)]
    pub harness_home: Option<PathBuf>,
    /// Canonical HTTPS origin; defaults to the loopback listener origin.
    #[arg(long)]
    pub origin: Option<String>,
    /// Additional canonical gateway origin; repeat for each entry point.
    #[arg(long = "entry-point")]
    pub entry_points: Option<Vec<String>>,
    /// Offered consent profile; repeat for each profile. Must include --permissions.
    #[arg(long = "profile", value_enum)]
    pub profiles: Option<Vec<PermissionProfile>>,
    /// Default consent profile (defaults to sandboxed).
    #[arg(long, value_enum)]
    pub permissions: Option<PermissionProfile>,
    #[arg(long)]
    pub listen: Option<SocketAddr>,
    #[arg(long)]
    pub session_image: Option<String>,
    #[arg(long)]
    pub egress_container: Option<String>,
    #[arg(long)]
    pub owner_passphrase_file: Option<PathBuf>,
    /// Apply the plan. Without this, a terminal guides setup and asks for confirmation.
    #[arg(long)]
    pub apply: bool,
    #[arg(long)]
    pub json: bool,
    #[arg(long)]
    pub non_interactive: bool,
    /// Explicitly invoke the existing provider login helper after private initialization.
    #[arg(long, conflicts_with_all = ["non_interactive", "json"])]
    pub login: bool,
    /// Leave service management to another supervisor.
    #[arg(long)]
    pub no_service: bool,
    /// Update only the configured session image to this release's default or --session-image.
    #[arg(long)]
    pub upgrade: bool,
}

#[derive(Args)]
pub struct ResetTotpCli {
    #[arg(long, env = "AGENT_CONNECT_CONFIG", hide_env_values = true)]
    pub config: Option<PathBuf>,
    /// Confirm offline authenticator recovery without a terminal prompt.
    #[arg(long)]
    pub yes: bool,
}

pub async fn reset_totp(cli: ResetTotpCli) -> anyhow::Result<()> {
    let path = cli.config.map(Ok).unwrap_or_else(|| {
        Ok::<_, anyhow::Error>(default_runtime_directory()?.join("config.json"))
    })?;
    let configured = config::ServeOptions {
        config: Some(path),
        ..Default::default()
    }
    .resolve()?;
    if configured.headless_static_bearer {
        return Err(usage("headless runtimes have no owner authenticator"));
    }
    if !cli.yes {
        if !std::io::stdin().is_terminal() || !std::io::stderr().is_terminal() {
            return Err(usage(
                "reset-totp requires owner terminal confirmation or explicit --yes; stop the gateway first",
            ));
        }
        if !confirm(
            "Reset the owner authenticator? Stop the gateway first; applications and owner passphrase are retained.",
        )? {
            return Ok(());
        }
    }
    let state = configured.state_dir.join("auth");
    let changed =
        tokio::task::spawn_blocking(move || crate::authorization::AuthService::reset_totp(&state))
            .await??;
    println!(
        "{}",
        if changed {
            "Owner authenticator reset. Restart the gateway, sign in with your owner passphrase, and enroll a new authenticator."
        } else {
            "Owner authenticator was already disabled; private state was preserved."
        }
    );
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupPlan {
    pub directory: PathBuf,
    pub config: PathBuf,
    pub existing: bool,
    pub harness: Harness,
    pub harness_home: PathBuf,
    pub origin: String,
    pub entry_points: Vec<String>,
    pub profiles: Vec<PermissionProfile>,
    pub permissions: PermissionProfile,
    pub listen: SocketAddr,
    pub session_image: String,
    pub egress_container: String,
    pub login: bool,
    pub login_required: bool,
    pub login_command: Vec<String>,
    pub service: bool,
    pub steps: Vec<&'static str>,
    pub upgrade: bool,
    pub previous_session_image: Option<String>,
}

fn usage(message: impl Into<String>) -> anyhow::Error {
    config::UsageError(message.into()).into()
}

pub fn default_runtime_directory() -> anyhow::Result<PathBuf> {
    // Both platform state conventions have the same Agent Connect root.
    Ok(credentials::default_home(Harness::Codex)?
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("runtime"))
}

fn absolute(path: &Path) -> anyhow::Result<PathBuf> {
    Ok(if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    })
}

pub fn setup_plan(cli: &SetupCli) -> anyhow::Result<SetupPlan> {
    let directory = absolute(
        &cli.directory
            .clone()
            .map(Ok)
            .unwrap_or_else(default_runtime_directory)?,
    )?;
    let path = directory.join("config.json");
    let existing = path.exists();
    let previous = if existing {
        Some(config::read_config(&path)?)
    } else {
        None
    };
    if directory.exists() && !existing {
        bail!(
            "runtime directory already exists without a valid configuration; choose a fresh directory or repair it explicitly"
        );
    }
    macro_rules! select {
        ($field:ident, $default:expr) => {
            cli.$field
                .clone()
                .or_else(|| previous.as_ref().and_then(|c| c.$field.clone()))
                .unwrap_or_else(|| $default)
        };
    }
    let harness = select!(harness, Harness::Codex);
    let home = cli
        .harness_home
        .clone()
        .or_else(|| previous.as_ref().and_then(|c| c.harness_home.clone()))
        .map(Ok)
        .unwrap_or_else(|| credentials::default_home(harness))?;
    let listen = select!(listen, "127.0.0.1:18940".parse().unwrap());
    if listen.port() == 0 {
        return Err(usage("setup requires a nonzero listener port"));
    }
    let origin = cli
        .origin
        .clone()
        .or_else(|| previous.as_ref().and_then(|c| c.public_url.clone()))
        .unwrap_or_else(|| format!("http://{listen}"));
    config::validate_public_url(&origin)?;
    let egress_container = select!(egress_container, "agent-connect-egress".into());
    config::validate_container_name(&egress_container)?;
    let previous_session_image = previous.as_ref().and_then(|c| c.session_image.clone());
    let session_image = if cli.upgrade {
        cli.session_image
            .clone()
            .unwrap_or_else(|| config::DEFAULT_SESSION_IMAGE.into())
    } else {
        select!(session_image, config::DEFAULT_SESSION_IMAGE.into())
    };
    validate_argument(&session_image)?;
    let home = absolute(&home)?;
    let home = if home.exists() || home.is_symlink() {
        anyhow::ensure!(
            !std::fs::symlink_metadata(&home)?.file_type().is_symlink(),
            "harness home must be a directory, not a symlink"
        );
        home.canonicalize()
            .context("resolve existing dedicated harness home")?
    } else {
        home
    };
    if directory.starts_with(&home) {
        return Err(usage(
            "runtime and owner state must be outside the mounted harness home",
        ));
    }
    let requested_policy = config::ServeOptions {
        harness: Some(harness),
        listen: Some(listen),
        public_url: Some(origin.clone()),
        entry_points: cli
            .entry_points
            .clone()
            .or_else(|| previous.as_ref().and_then(|c| c.entry_points.clone())),
        profiles: cli
            .profiles
            .clone()
            .or_else(|| previous.as_ref().and_then(|c| c.profiles.clone())),
        permissions: cli
            .permissions
            .or_else(|| previous.as_ref().and_then(|c| c.permissions)),
        boxed: Some(true),
        harness_home: Some(home.clone()),
        session_image: Some(session_image.clone()),
        egress_container: Some(egress_container.clone()),
        ..Default::default()
    }
    .resolve()?;
    if let Some(previous) = previous {
        if previous.headless_static_bearer == Some(true) {
            return Err(usage(
                "setup cannot convert a headless runtime; create a fresh owner runtime",
            ));
        }
        // A rerun resumes dependencies, rather than silently rewriting private state.
        if previous.harness != Some(harness)
            || previous.listen != Some(listen)
            || previous.public_url.as_deref() != Some(&origin)
            || previous.harness_home.as_ref() != Some(&home)
            || (!cli.upgrade && previous.session_image.as_deref() != Some(&session_image))
            || previous.egress_container.as_deref() != Some(&egress_container)
        {
            return Err(usage(
                "requested setup differs from the existing configuration; edit the private configuration explicitly or choose a fresh runtime",
            ));
        }
        let configured = config::ServeOptions {
            config: Some(path.clone()),
            ..Default::default()
        }
        .resolve()?;
        if configured.entry_points != requested_policy.entry_points
            || configured.profiles != requested_policy.profiles
            || configured.permissions != requested_policy.permissions
        {
            return Err(usage(
                "requested entry points or profiles differ from the existing policy; setup reruns and upgrades preserve existing application authority",
            ));
        }
        private_metadata(&directory, true)?;
        let state = previous
            .state_dir
            .unwrap_or_else(|| directory.join("state"));
        private_metadata(&state.join("auth/authorization.json"), false).context(
            "existing owner authentication state is missing or unsafe; setup never replaces it",
        )?;
    }
    let login_required = !credentials::credential_file_present(&home, harness);
    let login_command = vec![
        "agent-connect".into(),
        "login".into(),
        "--config".into(),
        path.to_string_lossy().into_owned(),
        "--harness".into(),
        match harness {
            Harness::Codex => "codex".into(),
            Harness::Claude => "claude".into(),
        },
    ];
    if cli.upgrade && !existing {
        return Err(usage(
            "--upgrade requires an existing private runtime; use setup without --upgrade for first installation",
        ));
    }
    Ok(SetupPlan {
        directory,
        config: path,
        existing,
        harness,
        harness_home: home,
        origin,
        entry_points: requested_policy.entry_points,
        profiles: requested_policy.profiles,
        permissions: requested_policy.permissions,
        listen,
        session_image,
        egress_container,
        login: cli.login,
        login_required,
        login_command,
        service: !cli.no_service,
        steps: vec![
            if cli.upgrade {
                "upgrade-session-image-preserve-private-state"
            } else if existing {
                "preserve-private-runtime"
            } else {
                "initialize-private-runtime"
            },
            "verify-session-image",
            "owner-login-if-requested",
            "start-owned-egress",
            if cli.no_service {
                "foreground-serve"
            } else {
                "install-and-start-user-service"
            },
        ],
        upgrade: cli.upgrade,
        previous_session_image,
    })
}

pub async fn setup(mut cli: SetupCli) -> anyhow::Result<()> {
    let terminal = std::io::stdin().is_terminal() && std::io::stderr().is_terminal();
    let guided = terminal && !cli.non_interactive && !cli.json && !cli.apply;
    if cli.login && (!terminal || cli.non_interactive || cli.json) {
        return Err(usage(
            "provider login requires an owner terminal and human output; use agent-connect login separately",
        ));
    }
    if guided {
        let preliminary = setup_plan(&cli)?;
        if !preliminary.existing && cli.harness.is_none() {
            let Some(harness) = credentials::select_harness(
                &mut std::io::stdin().lock(),
                &mut std::io::stderr().lock(),
                Harness::Codex,
            )?
            else {
                return Ok(());
            };
            cli.harness = Some(harness);
        }
        if !preliminary.existing && cli.origin.is_none() {
            cli.origin = Some(prompt("Gateway origin", &preliminary.origin)?);
        }
    }
    let mut plan = setup_plan(&cli)?;
    if guided {
        eprintln!(
            "Runtime: {}\nOwner sign-in: {}/agent-connect/owner\nHarness: {:?}\nEntry points: {}\nProfiles: {} (default {})\nService: {}",
            plan.directory.display(),
            plan.origin,
            plan.harness,
            plan.entry_points.join(", "),
            plan.profiles
                .iter()
                .map(|profile| profile.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            plan.permissions.as_str(),
            plan.service
        );
        if !confirm("Apply this setup?")? {
            return Ok(());
        }
        cli.apply = true;
        if !cli.login && plan.login_required {
            plan.login = confirm("Run the provider login helper in this terminal?")?;
        }
    }
    if !cli.apply {
        print_plan(&plan, cli.json)?;
        return Ok(());
    }
    if !plan.existing && (!terminal || cli.non_interactive) && cli.owner_passphrase_file.is_none() {
        return Err(usage(
            "unattended setup requires --owner-passphrase-file with a private passphrase file",
        ));
    }
    // Fail prerequisites before creating private authentication state.
    let image = NativeRunner
        .run(CommandSpec::new(
            "docker",
            [
                "image",
                "inspect",
                "--format",
                "{{.Id}}",
                &plan.session_image,
            ],
        ))
        .await?;
    if image.code != 0 {
        eprintln!("Pulling the configured session image; this may take several minutes.");
        let pulled = NativeRunner
            .run(CommandSpec::new("docker", ["pull", &plan.session_image]).deadline(300))
            .await?;
        pulled.success("session image could not be pulled; start Docker and use the image supplied by the installed release")?;
    }
    if plan.upgrade {
        let fresh = setup_plan(&cli)?;
        anyhow::ensure!(
            fresh.previous_session_image == plan.previous_session_image
                && fresh.origin == plan.origin
                && fresh.harness_home == plan.harness_home
                && fresh.listen == plan.listen
                && fresh.entry_points == plan.entry_points
                && fresh.profiles == plan.profiles
                && fresh.permissions == plan.permissions,
            "configuration changed during upgrade preparation; rerun from the new private state"
        );
        // Binary-only upgrades must replace the running process even when the
        // selected image and existing egress already match this release.
        if plan.service {
            service::stop_service_for_upgrade(&plan.config).await?;
        }
        let same_image = plan.previous_session_image.as_deref() == Some(&plan.session_image);
        let image = plan.session_image.clone();
        let egress = plan.egress_container.clone();
        let already_ready = same_image
            && tokio::task::spawn_blocking(move || crate::sandbox::preflight(&image, &egress))
                .await?
                .is_ok();
        if !already_ready {
            let listener = tokio::net::TcpListener::bind(plan.listen).await.context(
                "stop the running gateway before an image upgrade; its listener is still occupied",
            )?;
            drop(listener);
            upgrade_image(&plan.config, &plan.session_image)?;
            // Inspect before a stop so an absent container remains resumable. Ownership
            // is rechecked by egress_stop; unrelated resources are never removed.
            let existing_egress = NativeRunner
                .run(CommandSpec::new(
                    "docker",
                    ["container", "inspect", &plan.egress_container],
                ))
                .await?;
            if existing_egress.code == 0 {
                let name = plan.egress_container.clone();
                tokio::task::spawn_blocking(move || crate::sandbox::egress_stop(&name)).await??;
            }
        }
    }
    if !plan.existing {
        create_private_directory(plan.directory.parent().unwrap())?;
        let init = config::InitCli {
            directory: plan.directory.clone(),
            harness: plan.harness,
            harness_home: Some(plan.harness_home.clone()),
            allow_origin: None,
            tools: None,
            public_url: Some(plan.origin.clone()),
            owner_passphrase_file: cli.owner_passphrase_file,
            headless_static_bearer: false,
            listen: plan.listen,
            session_image: plan.session_image.clone(),
            egress_container: plan.egress_container.clone(),
        };
        tokio::task::spawn_blocking(move || config::init_quiet(init)).await??;
        persist_setup_policy(&plan.config, &plan)?;
    }
    if plan.login {
        let status = tokio::process::Command::new(std::env::current_exe()?)
            .args(["login", "--config"])
            .arg(&plan.config)
            .arg("--harness")
            .arg(match plan.harness {
                Harness::Codex => "codex",
                Harness::Claude => "claude",
            })
            .status()
            .await?;
        anyhow::ensure!(
            status.success(),
            "provider login was not completed; rerun setup or login explicitly"
        );
    }
    let name = plan.egress_container.clone();
    let image = plan.session_image.clone();
    tokio::task::spawn_blocking(move || crate::sandbox::egress_start(&name, &image)).await??;
    if plan.service {
        service::service_run(ServiceCli {
            config: Some(plan.config.clone()),
            manager: None,
            command: ServiceAction::Install { offline: false },
        })
        .await?;
        service::service_run(ServiceCli {
            config: Some(plan.config.clone()),
            manager: None,
            command: ServiceAction::Start,
        })
        .await?;
    }
    print_plan(&plan, cli.json)
}

fn upgrade_image(path: &Path, image: &str) -> anyhow::Result<()> {
    private_metadata(path, false)?;
    let original = std::fs::read(path)?;
    let mut value: serde_json::Value = serde_json::from_slice(&original)?;
    if value
        .get("session_image")
        .and_then(serde_json::Value::as_str)
        == Some(image)
    {
        return Ok(());
    }
    value
        .as_object_mut()
        .ok_or_else(|| usage("configuration must be an object"))?
        .insert("session_image".into(), image.into());
    let suffix = uuid::Uuid::new_v4();
    let backup = path.with_file_name(format!("config.json.pre-upgrade-{suffix}"));
    private_write(&backup, &original)?;
    replace_private_config(path, &serde_json::to_vec_pretty(&value)?)
}

fn persist_setup_policy(path: &Path, plan: &SetupPlan) -> anyhow::Result<()> {
    let mut configured = config::read_config(path)?;
    configured.entry_points = Some(plan.entry_points.clone());
    configured.profiles = Some(plan.profiles.clone());
    configured.permissions = Some(plan.permissions);
    configured.resolve()?;
    let mut value: serde_json::Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| usage("configuration must be an object"))?;
    object.insert(
        "entry_points".into(),
        serde_json::to_value(&plan.entry_points)?,
    );
    object.insert("profiles".into(), serde_json::to_value(&plan.profiles)?);
    object.insert(
        "permissions".into(),
        serde_json::to_value(plan.permissions)?,
    );
    replace_private_config(path, &serde_json::to_vec_pretty(&value)?)
}

fn replace_private_config(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    private_metadata(path, false)?;
    let staging = path.with_file_name(format!(".config.json.update-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        private_write(&staging, bytes)?;
        std::fs::rename(&staging, path)?;
        std::fs::File::open(path.parent().unwrap())?.sync_all()?;
        Ok::<_, anyhow::Error>(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    result
}
fn private_write(path: &Path, contents: &[u8]) -> anyhow::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents)?;
    file.sync_all()?;
    Ok(())
}

fn prompt(label: &str, default: &str) -> anyhow::Result<String> {
    eprint!("{label} [{default}]: ");
    std::io::stderr().flush()?;
    let mut answer = String::new();
    if std::io::stdin().lock().read_line(&mut answer)? == 0 {
        return Err(usage("setup cancelled at end of input"));
    }
    Ok(if answer.trim().is_empty() {
        default.into()
    } else {
        answer.trim().into()
    })
}
fn confirm(label: &str) -> anyhow::Result<bool> {
    Ok(matches!(
        prompt(label, "N")?.to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}
fn print_plan(plan: &SetupPlan, json: bool) -> anyhow::Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(plan)?);
    } else {
        println!(
            "Setup {}: {}\nOwner sign-in: {}/agent-connect/owner\n{}",
            if plan.existing { "resumes" } else { "creates" },
            plan.directory.display(),
            plan.origin,
            plan.steps.join(" → ")
        );
        if plan.login_required && !plan.login {
            println!(
                "Owner login required: agent-connect login --config {:?} --harness {}",
                plan.config,
                match plan.harness {
                    Harness::Codex => "codex",
                    Harness::Claude => "claude",
                }
            );
        }
        if !plan.service {
            println!("Start: agent-connect serve --config {:?}", plan.config);
        }
        if !plan.session_image.contains("@sha256:") {
            println!(
                "Development warning: mutable session image tag; use the release digest for production."
            );
        }
    }
    Ok(())
}

pub(super) fn validate_argument(value: &str) -> anyhow::Result<()> {
    if value.is_empty()
        || value.len() > 4096
        || value.starts_with('-')
        || value.chars().any(char::is_control)
    {
        return Err(usage(
            "command argument must be nonempty, bounded and contain no control characters or leading option marker",
        ));
    }
    Ok(())
}
pub(super) fn private_metadata(path: &Path, directory: bool) -> anyhow::Result<()> {
    let meta = std::fs::symlink_metadata(path)?;
    anyhow::ensure!(
        !meta.file_type().is_symlink()
            && if directory {
                meta.is_dir()
            } else {
                meta.is_file()
            },
        "expected a private regular {}",
        if directory { "directory" } else { "file" }
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        anyhow::ensure!(
            meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0,
            "must be owned by the current user and inaccessible to group/others"
        );
    }
    Ok(())
}
pub(super) fn create_private_directory(path: &Path) -> anyhow::Result<()> {
    if path.exists() || path.is_symlink() {
        let meta = std::fs::symlink_metadata(path)?;
        anyhow::ensure!(
            meta.is_dir() && !meta.file_type().is_symlink(),
            "directory must be a regular directory, not a symlink"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let safe_shared_temporary = meta.uid() == 0 && meta.mode() & 0o1000 != 0;
            anyhow::ensure!(
                safe_shared_temporary
                    || (meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o022 == 0),
                "directory must be owned by this user and not writable by group/others"
            );
        }
        return Ok(());
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options(directory: PathBuf) -> SetupCli {
        SetupCli {
            harness_home: Some(directory.join("dedicated-home")),
            directory: Some(directory.join("runtime")),
            harness: Some(Harness::Codex),
            origin: None,
            entry_points: None,
            profiles: None,
            permissions: None,
            listen: None,
            session_image: Some("session:test".into()),
            egress_container: None,
            owner_passphrase_file: None,
            apply: false,
            json: true,
            non_interactive: true,
            login: false,
            no_service: true,
            upgrade: false,
        }
    }
    #[test]
    fn planning_creates_nothing_and_rejects_unsafe_options() {
        let dir = std::env::temp_dir().join(format!("acp-plan-{}", uuid::Uuid::new_v4()));
        let mut cli = options(dir.clone());
        let plan = setup_plan(&cli).unwrap();
        assert!(!dir.exists());
        assert!(!plan.existing);
        assert!(!plan.login);
        assert!(plan.login_required);
        assert_eq!(plan.origin, "http://127.0.0.1:18940");
        assert_eq!(
            plan.profiles,
            [PermissionProfile::Sandboxed, PermissionProfile::ReadOnly]
        );
        assert_eq!(plan.permissions, PermissionProfile::Sandboxed);
        cli.origin = Some("https://example.test/path".into());
        assert!(setup_plan(&cli).is_err());
        cli.origin = None;
        cli.session_image = Some("--privileged".into());
        assert!(setup_plan(&cli).is_err());
        assert!(!dir.exists());
    }
    #[test]
    fn setup_policy_is_persisted_validated_and_preserved_on_reruns() {
        let dir = std::env::temp_dir().join(format!("acp-setup-policy-{}", uuid::Uuid::new_v4()));
        create_private_directory(&dir).unwrap();
        let passphrase = dir.join("owner-passphrase.txt");
        private_write(&passphrase, b"fixture-only-owner-passphrase").unwrap();
        let mut cli = options(dir.clone());
        let parent_component = dir.join("existing-parent");
        create_private_directory(&parent_component).unwrap();
        cli.harness_home = Some(parent_component.join("../dedicated-home"));
        cli.entry_points = Some(vec!["https://alternate.example".into()]);
        cli.profiles = Some(vec![PermissionProfile::ReadOnly]);
        cli.permissions = Some(PermissionProfile::ReadOnly);
        let plan = setup_plan(&cli).unwrap();
        config::init_quiet(config::InitCli {
            directory: plan.directory.clone(),
            harness: plan.harness,
            harness_home: Some(plan.harness_home.clone()),
            allow_origin: None,
            tools: None,
            public_url: Some(plan.origin.clone()),
            owner_passphrase_file: Some(passphrase),
            headless_static_bearer: false,
            listen: plan.listen,
            session_image: plan.session_image.clone(),
            egress_container: plan.egress_container.clone(),
        })
        .unwrap();
        let owner_path = plan.directory.join("state/auth/authorization.json");
        let owner_state = std::fs::read(&owner_path).unwrap();
        persist_setup_policy(&plan.config, &plan).unwrap();
        let config = config::ServeOptions {
            config: Some(plan.config.clone()),
            ..Default::default()
        }
        .resolve()
        .unwrap();
        assert_eq!(
            config.harness_home,
            Some(dir.join("dedicated-home").canonicalize().unwrap())
        );
        assert_eq!(config.entry_points, plan.entry_points);
        assert_eq!(config.profiles, plan.profiles);
        assert_eq!(config.permissions, PermissionProfile::ReadOnly);
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&plan.config).unwrap()).unwrap();
        assert_eq!(raw["state_dir"], "state");
        assert_eq!(raw["permissions"], "read-only");
        assert_eq!(std::fs::read(&owner_path).unwrap(), owner_state);
        let resumed = setup_plan(&cli).unwrap();
        assert!(resumed.existing);
        assert_eq!(resumed.harness_home, config.harness_home.unwrap());
        assert_eq!(resumed.profiles, plan.profiles);
        #[cfg(unix)]
        {
            let ancestor_alias = dir.join("ancestor-alias");
            std::os::unix::fs::symlink(&dir, &ancestor_alias).unwrap();
            cli.harness_home = Some(ancestor_alias.join("dedicated-home"));
            assert_eq!(setup_plan(&cli).unwrap().harness_home, resumed.harness_home);
            assert_eq!(std::fs::read(&owner_path).unwrap(), owner_state);
        }
        cli.entry_points = None;
        cli.profiles = None;
        cli.permissions = None;
        let inherited = setup_plan(&cli).unwrap();
        assert_eq!(inherited.entry_points, plan.entry_points);
        assert_eq!(inherited.profiles, plan.profiles);
        assert_eq!(inherited.permissions, plan.permissions);
        cli.profiles = Some(vec![
            PermissionProfile::Sandboxed,
            PermissionProfile::ReadOnly,
        ]);
        cli.permissions = Some(PermissionProfile::Sandboxed);
        assert!(setup_plan(&cli).is_err());
        assert_eq!(std::fs::read(&owner_path).unwrap(), owner_state);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn planning_rejects_unsupported_profiles_and_duplicate_origins() {
        let dir = std::env::temp_dir().join(format!("acp-policy-plan-{}", uuid::Uuid::new_v4()));
        let mut cli = options(dir.clone());
        cli.profiles = Some(vec![PermissionProfile::DenyAll]);
        cli.permissions = Some(PermissionProfile::DenyAll);
        assert!(setup_plan(&cli).is_err());
        cli.profiles = None;
        cli.permissions = None;
        cli.entry_points = Some(vec!["http://127.0.0.1:18940".into()]);
        assert!(setup_plan(&cli).is_err());
        assert!(!dir.exists());
    }
    #[test]
    fn image_upgrade_is_atomic_and_preserves_unknown_and_owner_fields() {
        let dir = std::env::temp_dir().join(format!("acp-upgrade-{}", uuid::Uuid::new_v4()));
        create_private_directory(&dir).unwrap();
        let path = dir.join("config.json");
        private_write(&path, br#"{"session_image":"old:tag","state_dir":"state","entry_points":["https://example.test"],"future":{"retained":true}}"#).unwrap();
        upgrade_image(&path, "new@sha256:123").unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["session_image"], "new@sha256:123");
        assert_eq!(value["future"]["retained"], true);
        assert_eq!(value["state_dir"], "state");
        let entries = std::fs::read_dir(&dir).unwrap().count();
        upgrade_image(&path, "new@sha256:123").unwrap();
        assert_eq!(entries, std::fs::read_dir(&dir).unwrap().count());
        private_metadata(&path, false).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn unsafe_existing_directories_are_rejected_without_chmod() {
        let dir = std::env::temp_dir().join(format!("acp-mode-{}", uuid::Uuid::new_v4()));
        create_private_directory(&dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
            assert!(create_private_directory(&dir).is_err());
            assert_eq!(
                std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o777
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct CommandSpec {
    program: String,
    args: Vec<String>,
    timeout_secs: u64,
}
impl CommandSpec {
    pub(super) fn new(
        program: impl Into<String>,
        args: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> Self {
        Self {
            program: program.into(),
            args: args.into_iter().map(|a| a.as_ref().to_owned()).collect(),
            timeout_secs: 15,
        }
    }
    fn deadline(mut self, seconds: u64) -> Self {
        self.timeout_secs = seconds;
        self
    }
}
pub(super) struct CommandOutput {
    pub code: i32,
    pub output: String,
}
impl CommandOutput {
    pub(super) fn success(&self, context: &str) -> anyhow::Result<()> {
        anyhow::ensure!(self.code == 0, "{context} (exit {})", self.code);
        Ok(())
    }
}
pub(super) trait Runner {
    async fn run(&mut self, command: CommandSpec) -> anyhow::Result<CommandOutput>;
}
pub(super) struct NativeRunner;
impl Runner for NativeRunner {
    async fn run(&mut self, command: CommandSpec) -> anyhow::Result<CommandOutput> {
        use std::process::Stdio;
        let mut child = tokio::process::Command::new(&command.program)
            .args(&command.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("run {}", command.program))?;
        let stdout = child.stdout.take().unwrap();
        let read = async move {
            let mut stdout = stdout;
            let mut retained = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let n = stdout.read(&mut buffer).await?;
                if n == 0 {
                    break;
                }
                let remaining = (64 * 1024usize).saturating_sub(retained.len());
                retained.extend_from_slice(&buffer[..n.min(remaining)]);
            }
            Ok::<_, std::io::Error>(retained)
        };
        let result = tokio::time::timeout(Duration::from_secs(command.timeout_secs), async {
            let (status, output) = tokio::try_join!(child.wait(), read)?;
            Ok::<_, std::io::Error>(CommandOutput {
                code: status.code().unwrap_or(1),
                output: String::from_utf8_lossy(&output).into_owned(),
            })
        })
        .await;
        match result {
            Ok(result) => Ok(result?),
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                bail!(
                    "{} exceeded its {}-second deadline",
                    command.program,
                    command.timeout_secs
                );
            }
        }
    }
}
