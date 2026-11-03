use super::{CommandSpec, NativeRunner, Runner, default_runtime_directory, private_metadata};
use crate::config;
use crate::engine::{Engine, ROOTFUL_FIX, ROOTFUL_RISK};
use clap::Args;
use serde::Serialize;
use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Args)]
pub struct DoctorCli {
    #[arg(long, env = "AGENT_CONNECT_CONFIG", hide_env_values = true)]
    pub config: Option<PathBuf>,
    #[arg(long)]
    pub json: bool,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Pass,
    Warn,
    Fail,
}
#[derive(Serialize)]
pub struct Check {
    pub code: &'static str,
    pub status: CheckStatus,
    pub message: String,
    pub fix: Option<String>,
}
#[derive(Serialize)]
pub struct DoctorReport {
    pub ok: bool,
    pub checks: Vec<Check>,
}
impl DoctorReport {
    fn add(
        &mut self,
        code: &'static str,
        status: CheckStatus,
        message: impl Into<String>,
        fix: Option<&str>,
    ) {
        self.ok &= status != CheckStatus::Fail;
        self.checks.push(Check {
            code,
            status,
            message: message.into(),
            fix: fix.map(str::to_owned),
        });
    }
}

pub async fn doctor(cli: DoctorCli) -> anyhow::Result<()> {
    let path = cli.config.map(Ok).unwrap_or_else(|| {
        Ok::<_, anyhow::Error>(default_runtime_directory()?.join("config.json"))
    })?;
    let report = doctor_report(&path).await;
    if cli.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        for check in &report.checks {
            println!("{:?} {}: {}", check.status, check.code, check.message);
            if let Some(fix) = &check.fix {
                println!("  Fix: {fix}");
            }
        }
    }
    anyhow::ensure!(report.ok, "doctor found checks requiring repair");
    Ok(())
}

/// Heavyweight owner-run CLI checks; do not call on every HTTP request.
/// Configuration is inspected, but credential contents and authentication state are never read.
pub async fn doctor_report(path: &std::path::Path) -> DoctorReport {
    let mut report = DoctorReport {
        ok: true,
        checks: Vec::new(),
    };
    let configured = match (config::ServeOptions {
        config: Some(path.to_owned()),
        ..Default::default()
    })
    .resolve()
    {
        Ok(cli) => {
            report.add(
                "config_valid",
                CheckStatus::Pass,
                "Private configuration is valid",
                None,
            );
            cli
        }
        Err(_) => {
            report.add("config_valid", CheckStatus::Fail, "Configuration is missing, invalid or has unsafe ownership/permissions", Some("Run agent-connect setup, or repair the private configuration and set mode 0600; credentials are not inspected"));
            return report;
        }
    };
    let directory = path.parent().unwrap_or(std::path::Path::new("."));
    match private_metadata(directory, true).and_then(|_| private_metadata(&configured.state_dir, true)) {
        Ok(()) => report.add("runtime_permissions", CheckStatus::Pass, "Runtime directories are private and owned by this user", None),
        Err(_) => report.add("runtime_permissions", CheckStatus::Fail, "Runtime or state directory permissions/ownership are unsafe", Some("Make the configured runtime and state directories owned by your user with mode 0700; avoid symlinks")),
    }
    if configured.headless_static_bearer {
        report.add(
            "owner_state",
            CheckStatus::Warn,
            "Explicit headless runtime has no owner sign-in",
            None,
        );
    } else {
        let auth = configured.state_dir.join("auth/authorization.json");
        match private_metadata(&auth, false) {
            Ok(()) => report.add("owner_state", CheckStatus::Pass, "Private owner authentication file is present (contents not read)", None),
            Err(_) => report.add("owner_state", CheckStatus::Fail, "Private owner authentication file is missing or unsafe", Some("Restore the existing private owner state or create a fresh runtime; setup will never overwrite an existing owner identity")),
        }
    }
    if crate::engine::for_runtime(configured.container_engine).is_err() {
        report.add(
            "engine_available",
            CheckStatus::Fail,
            "The requested container engine is not the one this runtime records",
            Some("Drop --container-engine and AGENT_CONNECT_CONTAINER_ENGINE, or edit container_engine in the private configuration and rerun setup"),
        );
        return report;
    }
    let mut runner = NativeRunner;
    let program = crate::engine::program();
    let info = runner
        .run(CommandSpec::new(program, crate::engine::info_args()))
        .await;
    let engine = match info {
        Ok(result) if result.code == 0 => {
            report.add(
                "engine_available",
                CheckStatus::Pass,
                format!("The container engine ({program}) is available to this user"),
                None,
            );
            crate::engine::parse_info(&result.output).ok()
        }
        _ => {
            report.add(
                "engine_available",
                CheckStatus::Fail,
                format!("The container engine ({program}) is unavailable or inaccessible"),
                Some("Start the engine and verify `docker info` or `podman info` as your user; do not run the gateway as root"),
            );
            None
        }
    };
    report_engine(&mut report, engine, configured.allow_rootful_engine);
    match runner
        .run(CommandSpec::new(
            program,
            [
                "image",
                "inspect",
                "--format",
                "{{.Id}}",
                &configured.box_image,
            ],
        ))
        .await
    {
        Ok(result) if result.code == 0 => report.add(
            "box_image",
            CheckStatus::Pass,
            "Configured box is installed",
            None,
        ),
        _ => report.add(
            "box_image",
            CheckStatus::Fail,
            "Configured box is absent or unavailable",
            Some("Run agent-connect setup to build the local box"),
        ),
    }
    let desired = match super::box_build::resolve_harness().await {
        Ok(harness) => super::box_build::desired_image(&harness),
        Err(error) => Err(error),
    };
    match desired {
        Ok(image) if image == configured.box_image => report.add(
            "box_current",
            CheckStatus::Pass,
            "Box matches this gateway version, the current harness releases and the owner layer",
            None,
        ),
        Ok(_) => {
            let refreshing =
                configured.box_refresh && config::locally_built_box(&configured.box_image);
            let state = super::box_refresh::load(&super::box_refresh::state_path(
                &configured.state_dir,
            ));
            let (status, message, fix) =
                judge_box_behind(refreshing, &state, super::box_refresh::now());
            report.add("box_current", status, message, fix)
        }
        Err(error) => report.add(
            "box_current",
            CheckStatus::Warn,
            format!("Cannot check whether the box is current: {error:#}"),
            Some("Check the network and the owner box directory, then run agent-connect doctor again"),
        ),
    }
    if let Some(home) = &configured.harness_home {
        if private_metadata(home, true).is_ok() {
            report.add(
                "harness_home",
                CheckStatus::Pass,
                "Dedicated harness home is private (contents not read)",
                None,
            );
            if crate::credentials::credential_file_present(home, configured.harness) {
                report.add(
                    "login_file_present",
                    CheckStatus::Pass,
                    "Harness credential file is present; validity is not inspected",
                    None,
                );
            } else {
                report.add("login_required", CheckStatus::Warn, "No supported harness credential file is present; no live login was attempted", Some("Run agent-connect login --config <private-runtime>/config.json in your own terminal; macOS Claude may instead use its credential store"));
            }
        } else {
            report.add("harness_home", CheckStatus::Fail, "Dedicated harness home is missing or unsafe", Some("Create the dedicated configured home as your user with mode 0700; keep it separate from private owner state"));
        }
    }
    let port = tokio::net::TcpListener::bind(configured.listen).await;
    // The gateway runs its network proxy only while it serves.
    if port.is_err()
        && let Some(egress) = configured.egress_container.clone()
    {
        let image = configured.box_image.clone();
        match tokio::task::spawn_blocking(move || crate::sandbox::preflight(&image, &egress)).await {
            Ok(Ok(())) => report.add("network_proxy", CheckStatus::Pass, "The gateway's network proxy matches the box and restricted configuration", None),
            _ => report.add("network_proxy", CheckStatus::Fail, "The gateway's network proxy is absent, stopped, unhealthy or does not match the configured box", Some("Restart the gateway service; a container it does not own is never changed")),
        }
    }
    match port {
        Ok(listener) => { drop(listener); report.add("listener_port", CheckStatus::Pass, "Configured listener port is available", None); },
        // A running gateway holds its own port; only a listener that is not a
        // ready gateway of this version is worth a warning.
        Err(_) => match ready_gateway_version(configured.listen).await {
            Some(version) if version == env!("CARGO_PKG_VERSION") => report.add("listener_port", CheckStatus::Pass, "A ready gateway of this version is listening on the configured port", None),
            // Upgraded but not restarted: the old binary still serves.
            Some(version) => report.add("listener_port", CheckStatus::Warn, format!("A ready gateway of version {version} is listening; this is {}", env!("CARGO_PKG_VERSION")), Some(concat!("Restart the gateway service to run ", env!("CARGO_PKG_VERSION")))),
            None => report.add("listener_port", CheckStatus::Warn, "Listener port is occupied or cannot be bound, and nothing there answers as a ready gateway", Some("Check service status and health; if another application owns the port, choose a different --listen address")),
        },
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if timestamp >= 1_704_067_200 {
        report.add(
            "clock",
            CheckStatus::Pass,
            "System clock is plausible; network synchronization is not verified",
            None,
        );
    } else {
        report.add(
            "clock",
            CheckStatus::Fail,
            "System clock is implausible; TLS, OAuth and TOTP depend on accurate time",
            Some("Enable system network time synchronization before pairing or owner sign-in"),
        );
    }
    if let Some(origin) = &configured.public_url {
        match reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(5)).connect_timeout(Duration::from_secs(3)).build() {
            Ok(client) => match client.get(format!("{origin}/healthz")).send().await {
                Ok(response) if response.status().is_success() => {
                    if health_ready(response).await {
                        report.add("public_reachable", CheckStatus::Pass, "Configured public health route is reachable and ready", None);
                    } else { report.add("public_reachable", CheckStatus::Warn, "Public route responds but does not report gateway readiness", Some("Check service status and configure the public proxy to forward /healthz and all /agent-connect/* routes to the gateway")); }
                },
                _ => report.add("public_reachable", CheckStatus::Warn, "Configured public health route is not reachable and ready (TLS verification is required)", Some("Start the gateway service; verify DNS and the HTTPS reverse proxy, including /healthz, owner/OAuth routes and ACP WebSocket upgrade")),
            },
            Err(_) => report.add("public_reachable", CheckStatus::Fail, "HTTP diagnostic client could not be initialized", Some("Check system certificate trust and retry doctor")),
        }
    }
    report
}

/// A rootful engine makes the gateway root-equivalent. The gateway keeps
/// serving either way; doctor reports the risk until the owner records it.
fn report_engine(report: &mut DoctorReport, engine: Option<Engine>, accepted: bool) {
    match (engine, accepted) {
        (Some(Engine::Rootless | Engine::RootlessPodman), _) => report.add(
            "engine_rootless",
            CheckStatus::Pass,
            "The container engine is rootless; boxes cannot start host root",
            None,
        ),
        (Some(Engine::VirtualMachine), _) => report.add(
            "engine_rootless",
            CheckStatus::Pass,
            "The container engine runs in a virtual machine; its root is not host root",
            None,
        ),
        (Some(Engine::Rootful), true) => report.add(
            "engine_rootless",
            CheckStatus::Warn,
            format!("{ROOTFUL_RISK}; the owner accepted this"),
            Some("Run rootless Podman or Docker in rootless mode for this user to remove the risk"),
        ),
        (Some(Engine::Rootful), false) => report.add(
            "engine_rootless",
            CheckStatus::Fail,
            ROOTFUL_RISK,
            Some(ROOTFUL_FIX),
        ),
        (None, _) => report.add(
            "engine_rootless",
            CheckStatus::Fail,
            "Cannot tell whether the container engine is rootless",
            Some("Start the engine and verify `docker info` or `podman info` as your user"),
        ),
    }
}

/// A box behind the current releases is fine while a serving gateway is
/// refreshing it; doctor warns only when that refresh is failing or stuck.
fn judge_box_behind(
    refreshing: bool,
    state: &super::box_refresh::RefreshState,
    now: u64,
) -> (CheckStatus, String, Option<&'static str>) {
    const HOUR: u64 = 60 * 60;
    let ago = |at: u64| format!("{} hours ago", now.saturating_sub(at) / HOUR);
    if !refreshing {
        return (
            CheckStatus::Warn,
            "A newer harness release, gateway version or owner box change is waiting".into(),
            Some("Run agent-connect setup to rebuild"),
        );
    }
    if let Some(error) = &state.error {
        return (
            CheckStatus::Warn,
            format!("The last box refresh failed: {error}"),
            Some("Check the gateway service log; agent-connect setup rebuilds by hand"),
        );
    }
    match state.checked_at {
        Some(at) if now.saturating_sub(at) <= super::box_refresh::CHECK_INTERVAL_SECS + HOUR => {}
        Some(at) => {
            return (
                CheckStatus::Warn,
                format!(
                    "The serving gateway last checked for a newer box {}",
                    ago(at)
                ),
                Some("Check that the gateway service is running"),
            );
        }
        None => {
            return (
                CheckStatus::Warn,
                "A newer box is waiting and no serving gateway has checked for one".into(),
                Some("Start the gateway service, or run agent-connect setup to rebuild"),
            );
        }
    }
    match (&state.pending, state.waiting_since) {
        (Some(_), Some(since)) if now.saturating_sub(since) > 48 * HOUR => (
            CheckStatus::Warn,
            format!(
                "A new box was built {} and is still waiting for every session to end",
                ago(since)
            ),
            Some("End sessions you no longer use, or restart the gateway service"),
        ),
        (Some(_), _) => (
            CheckStatus::Pass,
            "A newer box is built; the gateway swaps it in when no session runs".into(),
            None,
        ),
        _ => (
            CheckStatus::Pass,
            "A newer release is out; the gateway's daily refresh picks it up".into(),
            None,
        ),
    }
}

/// The version a ready gateway on `listen` reports, or "unknown". The
/// listener is untrusted and its answer reaches the terminal, so only a short
/// plain version string is kept.
async fn ready_gateway_version(listen: std::net::SocketAddr) -> Option<String> {
    let mut address = listen;
    if address.ip().is_unspecified() {
        address.set_ip(if address.is_ipv4() {
            std::net::Ipv4Addr::LOCALHOST.into()
        } else {
            std::net::Ipv6Addr::LOCALHOST.into()
        });
    }
    let Ok(client) = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
    else {
        return None;
    };
    let response = client
        .get(format!("http://{address}/healthz"))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let health = health_body(response).await?;
    (health.get("ready").and_then(serde_json::Value::as_bool) == Some(true)).then(|| {
        health
            .get("version")
            .and_then(serde_json::Value::as_str)
            .filter(|version| {
                !version.is_empty()
                    && version.len() <= 64
                    && version
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'))
            })
            .unwrap_or("unknown")
            .to_owned()
    })
}

async fn health_ready(response: reqwest::Response) -> bool {
    health_body(response)
        .await
        .is_some_and(|value| value.get("ready").and_then(serde_json::Value::as_bool) == Some(true))
}

async fn health_body(mut response: reqwest::Response) -> Option<serde_json::Value> {
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > 64 * 1024 {
                    return None;
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return None,
        }
    }
    serde_json::from_slice(&body).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn missing_config_reports_stable_repair_without_running_commands() {
        let directory = std::env::temp_dir().join(format!("acp-doctor-{}", uuid::Uuid::new_v4()));
        let report = doctor_report(&directory.join("config.json")).await;
        assert!(!report.ok);
        assert_eq!(report.checks.len(), 1);
        assert_eq!(report.checks[0].code, "config_valid");
        assert!(report.checks[0].fix.is_some());
        assert!(!directory.exists());
    }
    #[test]
    fn a_rootful_engine_fails_until_the_owner_accepts_it() {
        let status = |engine, accepted| {
            let mut report = DoctorReport {
                ok: true,
                checks: Vec::new(),
            };
            report_engine(&mut report, engine, accepted);
            (report.checks[0].status, report.ok)
        };
        assert_eq!(
            status(Some(Engine::Rootless), false),
            (CheckStatus::Pass, true)
        );
        assert_eq!(
            status(Some(Engine::Rootful), true),
            (CheckStatus::Warn, true)
        );
        assert_eq!(
            status(Some(Engine::Rootful), false),
            (CheckStatus::Fail, false)
        );
        assert_eq!(status(None, true), (CheckStatus::Fail, false));
    }
    #[test]
    fn a_behind_box_warns_only_when_its_refresh_fails_or_stalls() {
        use super::super::box_refresh::RefreshState;
        const HOUR: u64 = 60 * 60;
        let now = 1_000 * HOUR;
        let status = |refreshing, state: RefreshState| judge_box_behind(refreshing, &state, now).0;
        let checked = RefreshState {
            checked_at: Some(now - HOUR),
            ..Default::default()
        };
        assert_eq!(status(true, checked.clone()), CheckStatus::Pass);
        let waiting = |hours| RefreshState {
            pending: Some("agent-connect-box:0.0.4-0123456789abcdef".into()),
            waiting_since: Some(now - hours * HOUR),
            ..checked.clone()
        };
        assert_eq!(status(true, waiting(47)), CheckStatus::Pass);
        assert_eq!(status(true, waiting(49)), CheckStatus::Warn);
        let failed = RefreshState {
            error: Some("npm unreachable".into()),
            ..checked.clone()
        };
        assert_eq!(status(true, failed), CheckStatus::Warn);
        let stale = RefreshState {
            checked_at: Some(now - 26 * HOUR),
            ..waiting(1)
        };
        assert_eq!(status(true, stale), CheckStatus::Warn);
        assert_eq!(status(true, RefreshState::default()), CheckStatus::Warn);
        assert_eq!(status(false, checked), CheckStatus::Warn);
    }

    #[tokio::test]
    async fn a_ready_gateway_on_its_port_reports_its_version() {
        async fn serve(body: &'static str) -> std::net::SocketAddr {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let app = axum::Router::new()
                .route("/healthz", axum::routing::get(move || async move { body }));
            tokio::spawn(async move { axum::serve(listener, app).await });
            address
        }
        let version = |body| async move { ready_gateway_version(serve(body).await).await };
        assert_eq!(
            version(r#"{"status":"ok","ready":true,"version":"1.2.3"}"#)
                .await
                .as_deref(),
            Some("1.2.3")
        );
        assert_eq!(
            version(r#"{"ready":true}"#).await.as_deref(),
            Some("unknown")
        );
        assert_eq!(
            version(r#"{"ready":true,"version":"1.2.3\u001b[2J"}"#)
                .await
                .as_deref(),
            Some("unknown")
        );
        assert_eq!(
            version(r#"{"status":"ok","ready":false,"version":"1.2.3"}"#).await,
            None
        );
        assert_eq!(version("hello").await, None);
        let mut wildcard = serve(r#"{"ready":true,"version":"1.2.3"}"#).await;
        wildcard.set_ip(std::net::Ipv4Addr::UNSPECIFIED.into());
        assert_eq!(
            ready_gateway_version(wildcard).await.as_deref(),
            Some("1.2.3")
        );
    }
}
