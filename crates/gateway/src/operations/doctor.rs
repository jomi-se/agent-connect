use super::{CommandSpec, NativeRunner, Runner, default_runtime_directory, private_metadata};
use crate::{Harness, config};
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
    let mut runner = NativeRunner;
    match runner
        .run(CommandSpec::new(
            "docker",
            ["info", "--format", "{{.ServerVersion}}"],
        ))
        .await
    {
        Ok(result) if result.code == 0 => report.add(
            "docker_available",
            CheckStatus::Pass,
            "Docker is available to this user",
            None,
        ),
        _ => report.add(
            "docker_available",
            CheckStatus::Fail,
            "Docker is unavailable or its daemon is inaccessible",
            Some(
                "Start Docker and verify docker info as your user; do not run the gateway as root",
            ),
        ),
    }
    match runner
        .run(CommandSpec::new(
            "docker",
            [
                "image",
                "inspect",
                "--format",
                "{{.Id}}",
                &configured.session_image,
            ],
        ))
        .await
    {
        Ok(result) if result.code == 0 => report.add(
            "session_image",
            CheckStatus::Pass,
            "Configured session image is installed",
            None,
        ),
        _ => report.add(
            "session_image",
            CheckStatus::Fail,
            "Configured session image is absent or unavailable",
            Some("Install the selected release session image, then rerun setup"),
        ),
    }
    if configured.session_image.contains("@sha256:") {
        report.add(
            "session_image_pin",
            CheckStatus::Pass,
            "Session image uses an immutable digest reference",
            None,
        );
    } else {
        report.add(
            "session_image_pin",
            CheckStatus::Warn,
            "Session image uses a mutable development tag",
            Some("Use the digest-pinned image supplied by the installed release for production"),
        );
    }
    if let Some(egress) = configured.egress_container.clone() {
        let image = configured.session_image.clone();
        match tokio::task::spawn_blocking(move || crate::sandbox::preflight(&image, &egress)).await {
            Ok(Ok(())) => report.add("egress_owned_ready", CheckStatus::Pass, "Owned egress proxy matches the session image and restricted configuration", None),
            _ => report.add("egress_owned_ready", CheckStatus::Fail, "Owned egress proxy is absent, stopped, unhealthy or does not match the configured image", Some("Run agent-connect setup --apply --non-interactive to resume owned egress, or use agent-connect egress start with the configured name and image; foreign containers are never changed")),
        }
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
    match tokio::net::TcpListener::bind(configured.listen).await {
        Ok(listener) => { drop(listener); report.add("listener_port", CheckStatus::Pass, "Configured listener port is available", None); },
        Err(_) => report.add("listener_port", CheckStatus::Warn, "Listener port is occupied or cannot be bound; a running gateway may own it", Some("Check service status and health; if another application owns the port, choose a different --listen address")),
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

async fn health_ready(mut response: reqwest::Response) -> bool {
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > 64 * 1024 {
                    return false;
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return false,
        }
    }
    serde_json::from_slice::<serde_json::Value>(&body)
        .is_ok_and(|value| value.get("ready").and_then(serde_json::Value::as_bool) == Some(true))
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
}
