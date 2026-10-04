// Browser-facing ACP gateway.
//
// One WebSocket per application connection. Each connection gets its own
// chain and adapter process:
//
//   browser --WebSocket(ACP)--> [PolicyProxy -> McpOverAcpPolyfill] -> adapter
//
// Browser WebSocket constructors cannot set headers, so the bearer token
// travels as a subprotocol (`bearer.<token>`) next to the ACP subprotocol,
// which the server selects. The Origin header is checked against an allowlist;
// WebSocket upgrades are not protected by CORS.
//
// A client that also offers `agent-connect.resume.v1` gets a session host
// that outlives its socket (see `resume.rs`); otherwise the chain ends with
// the socket, as before.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use agent_client_protocol::AcpAgent;
use agent_client_protocol::{ConnectTo, Lines};
use agent_client_protocol_conductor::{ConductorImpl, ProxiesAndAgent};
use agent_client_protocol_polyfill::mcp_over_acp::McpOverAcpPolyfill;
use agent_connect_gateway::authorization::{
    AuthConfig, AuthService, AuthorizedGrant, OwnerProblem, OwnerRuntime, OwnerRuntimeSnapshot,
    OwnerSession,
};
use agent_connect_gateway::config::{
    self, CodexMode, DEFAULT_BOX_IMAGE, InitCli, ServeCli, ServeOptions, UsageError,
};
use agent_connect_gateway::credentials::{HarnessHome, default_home, login_args, select_harness};
use agent_connect_gateway::operations::{self, DoctorCli, ResetTotpCli, ServiceCli, SetupCli};
use agent_connect_gateway::policy::{GrantSessions, PermissionProfile, PolicyConfig, PolicyProxy};
use agent_connect_gateway::resume::{
    self, AttachError, Host, RESUME_SUBPROTOCOL, Registry, ResumeConfig, ToSocket, close,
};
use agent_connect_gateway::sandbox::{SessionNetwork, box_args, egress_start, egress_stop};
use agent_connect_gateway::{Harness, SpikePaths, mock_harness};
use anyhow::Context;
use axum::Router;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::get;
use clap::{Args, Parser, Subcommand};
use serde_json::Value;

const ACP_SUBPROTOCOL: &str = "acp.v1";
const BEARER_PREFIX: &str = "bearer.";
const MAX_CLIENT_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Parser)]
#[command(
    name = "agent-connect",
    version,
    about = "Unreleased, unstable ACP application gateway",
    after_help = "Example:\n  agent-connect setup\n  agent-connect setup --origin https://gateway.example\n  agent-connect doctor\n  agent-connect service status\n\nExit codes: 0 success; 1 runtime or readiness failure; 2 invalid arguments or configuration. ACP and MCP-over-ACP are unstable."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Guided private setup, harness login, egress and user service.
    Setup(SetupCli),
    /// Diagnose configuration, boxed runtime, login presence and public reachability.
    Doctor(DoctorCli),
    /// Install and operate the gateway's per-user systemd or launchd service.
    Service(ServiceCli),
    /// Reset a lost owner TOTP factor offline; stop the service first.
    ResetTotp(ResetTotpCli),
    /// Serve owner sign-in, app consent, grant management and unstable ACP.
    Serve(ServeOptions),
    /// Create a private runtime and owner sign-in for browser pairing.
    Init(InitCli),
    /// Sign in using the provider CLI in the dedicated harness home.
    Login(LoginCli),
    /// Manage the gateway-owned egress proxy (Docker required).
    Egress(EgressCli),
    /// Print machine-readable release version.
    ReleaseInfo,
}
#[derive(Args)]
struct LoginCli {
    /// Skip the interactive selector and choose this harness.
    #[arg(long, value_enum)]
    harness: Option<Harness>,
    /// Dedicated whole home; defaults to the platform's Agent Connect state directory.
    #[arg(long, env = "AGENT_CONNECT_HARNESS_HOME", hide_env_values = true)]
    harness_home: Option<std::path::PathBuf>,
    /// Use the harness home and image from an existing private runtime config.
    #[arg(long, env = "AGENT_CONNECT_CONFIG", hide_env_values = true)]
    config: Option<std::path::PathBuf>,
    #[arg(long, env = "AGENT_CONNECT_BOX_IMAGE")]
    box_image: Option<String>,
}

#[derive(Args)]
struct EgressCli {
    #[command(subcommand)]
    command: EgressCommand,
}
#[derive(Subcommand)]
enum EgressCommand {
    /// Start an isolated proxy; no host port is published.
    Start {
        #[arg(
            long,
            env = "AGENT_CONNECT_EGRESS_CONTAINER",
            default_value = "agent-connect-egress"
        )]
        name: String,
        #[arg(long, env = "AGENT_CONNECT_BOX_IMAGE", default_value = DEFAULT_BOX_IMAGE)]
        box_image: String,
    },
    /// Remove a proxy only after verifying the gateway ownership label.
    Stop {
        #[arg(
            long,
            env = "AGENT_CONNECT_EGRESS_CONTAINER",
            default_value = "agent-connect-egress"
        )]
        name: String,
    },
}

struct Gateway {
    cli: ServeCli,
    home: Option<HarnessHome>,
    capacity: Arc<tokio::sync::Semaphore>,
    sessions: Mutex<tokio::task::JoinSet<()>>,
    shutdown: tokio::sync::watch::Sender<bool>,
    /// Session ownership is partitioned by the stable grant, not an access token.
    grant_sessions: Mutex<BTreeMap<String, GrantSessions>>,
    authorization: Option<Arc<AuthService>>,
    snapshot: BTreeMap<String, Value>,
    paths: SpikePaths,
    hosts: Arc<Registry>,
    readiness: Mutex<Readiness>,
}

struct Readiness {
    checked_at: Instant,
    problem: bool,
}

struct ConsoleRuntime(Weak<Gateway>);

impl OwnerRuntime for ConsoleRuntime {
    fn snapshot(&self) -> OwnerRuntimeSnapshot {
        let Some(gateway) = self.0.upgrade() else {
            return OwnerRuntimeSnapshot::default();
        };
        let readiness = gateway.readiness.lock().unwrap();
        let mut problems = Vec::new();
        if readiness.problem
            || (gateway.cli.boxed && readiness.checked_at.elapsed() > Duration::from_secs(60))
        {
            problems.push(OwnerProblem {
                message: "Sessions cannot start: the box runtime is not responding.".into(),
                repair: "On the gateway host, run agent-connect doctor to check Docker, the box and the network proxy.".into(),
            });
        }
        if gateway.capacity.is_closed() {
            problems.push(OwnerProblem {
                message: "The gateway is shutting down.".into(),
                repair: "On the gateway host, check it with agent-connect service status or restart it with agent-connect service start.".into(),
            });
        }
        let sessions: Vec<_> = gateway.hosts.session_views().into_iter().map(|session| {
            if session.state == "cleanup-failed" {
                problems.push(OwnerProblem { message: "A session could not clean up its container, so its slot stays taken.".into(), repair: "On the gateway host, run agent-connect doctor and check agent-connect service logs before restarting.".into() });
            }
            OwnerSession { id: session.id, grant_id: session.grant_id, state: session.state.into(), started_at: session.started_at }
        }).collect();
        OwnerRuntimeSnapshot { problems, sessions }
    }

    fn end_session(&self, id: &str) -> anyhow::Result<()> {
        let gateway = self.0.upgrade().context("gateway is stopping")?;
        if !gateway.hosts.end_session(id) {
            anyhow::bail!("session has already ended");
        }
        Ok(())
    }
}

#[derive(Clone)]
struct GrantContext {
    id: String,
    snapshot: BTreeMap<String, Value>,
    tool_definitions: Option<BTreeMap<String, Value>>,
    sessions: GrantSessions,
    access: Option<AuthorizedGrant>,
    permissions: PermissionProfile,
}
impl Gateway {
    fn authenticate(&self, token: &str, origin: &str, headers: &HeaderMap) -> Option<GrantContext> {
        let (id, snapshot, tool_definitions, access) = if let Some(service) = &self.authorization {
            let issuer = service.entry_point(headers).ok()?;
            let access = service.authenticate_at(token, origin, &issuer).ok()?;
            (
                access.id.clone(),
                access.snapshot.clone(),
                Some(access.tool_definitions.clone()),
                Some(access),
            )
        } else {
            if origin != self.cli.allow_origin
                || !resume::constant_time_eq(token.as_bytes(), self.cli.token.as_bytes())
            {
                return None;
            }
            ("headless".to_string(), self.snapshot.clone(), None, None)
        };
        let mut ownership = self.grant_sessions.lock().unwrap();
        ownership.retain(|grant_id, _| self.grant_active(grant_id));
        let sessions = ownership.entry(id.clone()).or_default().clone();
        let permissions = access
            .as_ref()
            .map_or(self.cli.permissions, |access| access.permissions);
        Some(GrantContext {
            id,
            snapshot,
            tool_definitions,
            sessions,
            access,
            permissions,
        })
    }
    fn grant_active(&self, id: &str) -> bool {
        self.authorization
            .as_ref()
            .is_none_or(|service| service.is_grant_active(id))
    }
    fn access_active(&self, grant: &GrantContext) -> bool {
        match (&self.authorization, &grant.access) {
            (Some(service), Some(access)) => service.recheck(access),
            (None, None) => true,
            _ => false,
        }
    }
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error:#}");
            std::process::ExitCode::from(if error.downcast_ref::<UsageError>().is_some() {
                2
            } else {
                1
            })
        }
    }
}

async fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let mut cli = match Cli::parse().command {
        Command::Serve(cli) => cli.resolve()?,
        Command::ReleaseInfo => {
            println!(
                "{}",
                serde_json::json!({
                    "version": env!("CARGO_PKG_VERSION"),
                })
            );
            return Ok(());
        }
        Command::Init(cli) => return config::init(cli),
        Command::Setup(cli) => return operations::setup(cli).await,
        Command::Doctor(cli) => return operations::doctor(cli).await,
        Command::Service(cli) => return operations::service(cli).await,
        Command::ResetTotp(cli) => return operations::reset_totp(cli).await,
        Command::Egress(cli) => {
            match cli.command {
                EgressCommand::Start { name, box_image } => {
                    egress_start(&name, &box_image)?;
                    println!("Egress proxy started: {name}");
                }
                EgressCommand::Stop { name } => {
                    egress_stop(&name)?;
                    println!("Egress proxy stopped: {name}");
                }
            }
            return Ok(());
        }
        Command::Login(cli) => {
            use std::io::IsTerminal;
            let configured = cli.config.as_deref().map(config::read_config).transpose()?;
            let harness = if let Some(harness) = cli.harness {
                harness
            } else {
                if !std::io::stdin().is_terminal() || !std::io::stderr().is_terminal() {
                    return Err(UsageError("login needs a terminal for its selector; pass --harness codex or --harness claude to choose explicitly".into()).into());
                }
                let Some(harness) = select_harness(
                    &mut std::io::stdin().lock(),
                    &mut std::io::stderr().lock(),
                    configured
                        .as_ref()
                        .and_then(|c| c.harness)
                        .unwrap_or(Harness::Codex),
                )?
                else {
                    return Ok(());
                };
                harness
            };
            if let Some(configured_harness) = configured.as_ref().and_then(|c| c.harness) {
                if configured_harness != harness {
                    return Err(UsageError("selected harness does not match --config; use its configured harness or omit --config".into()).into());
                }
            }
            let path = cli
                .harness_home
                .or_else(|| configured.as_ref().and_then(|c| c.harness_home.clone()))
                .map(Ok)
                .unwrap_or_else(|| default_home(harness))?;
            let home = HarnessHome::prepare(&path)?;
            let image = cli
                .box_image
                .or_else(|| configured.and_then(|c| c.box_image))
                .unwrap_or_else(|| DEFAULT_BOX_IMAGE.into());
            eprintln!("Dedicated harness home: {}", home.path.display());
            if matches!(harness, Harness::Claude) {
                eprintln!(
                    "Claude Code usage through Agent Connect is unconfirmed against Anthropic terms."
                );
            }
            let status = std::process::Command::new("docker")
                .args(login_args(&home, &image, harness))
                .status()?;
            anyhow::ensure!(status.success(), "provider login helper failed");
            eprintln!("Login complete. This dedicated home is ready for boxed sessions.");
            return Ok(());
        }
    };
    cli.codex_mode.get_or_insert_with(|| {
        if cli.boxed {
            CodexMode::AgentFullAccess
        } else {
            CodexMode::WorkspaceWrite
        }
    });
    let snapshot = if cli.headless_static_bearer {
        config::load_snapshot(&cli.tools)?
    } else {
        BTreeMap::new()
    };
    let home = cli
        .harness_home
        .as_deref()
        .map(HarnessHome::prepare)
        .transpose()?;
    std::fs::create_dir_all(&cli.state_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli.state_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    cli.state_dir = cli.state_dir.canonicalize()?;
    if !cli.headless_static_bearer
        && let Some(home) = &home
    {
        if cli.state_dir.starts_with(&home.path)
            || cli
                .config_path
                .as_ref()
                .is_some_and(|path| path.starts_with(&home.path))
        {
            return Err(UsageError("owner configuration and authorization state must be outside the mounted harness home".into()).into());
        }
    }
    if cli.boxed {
        let image = cli.box_image.clone();
        let egress = cli.egress_container.clone().unwrap();
        tokio::task::spawn_blocking(move || {
            agent_connect_gateway::sandbox::preflight(&image, &egress)
        })
        .await?
        .context("serve preflight failed; run agent-connect doctor for actionable checks and repair commands")?;
    }
    let paths = SpikePaths {
        root: cli
            .mock_root
            .clone()
            .unwrap_or_else(|| std::path::PathBuf::from(".")),
    };
    let listen = cli.listen;
    let hosts = Registry::new(ResumeConfig {
        grace: Duration::from_secs(cli.resume_grace_secs),
        max_retained_bytes: cli.resume_max_bytes,
    });
    let authorization = if let Some(public_url) = &cli.public_url {
        use sha2::{Digest, Sha256};
        let profile = serde_json::json!({
            "harness": cli.harness, "mode": cli.codex_mode, "permissions": cli.permissions,
            "boxed": cli.boxed, "image": cli.box_image, "home": cli.harness_home,
            "egress": cli.egress_container, "public_url": public_url,
        });
        let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&profile)?));
        Some(AuthService::open(AuthConfig {
            public_url: public_url.clone(),
            state_dir: cli.state_dir.join("auth"),
            policy_fingerprint: fingerprint,
            owner_passphrase: None,
            entry_points: cli.entry_points.clone(),
            profiles: cli.profiles.clone(),
            default_profile: cli.permissions,
            harness: cli.harness,
        })?)
    } else {
        None
    };
    let gateway = Arc::new(Gateway {
        hosts,
        home,
        capacity: Arc::new(tokio::sync::Semaphore::new(cli.max_sessions)),
        sessions: Mutex::new(tokio::task::JoinSet::new()),
        shutdown: tokio::sync::watch::channel(false).0,
        cli,
        snapshot,
        paths,
        grant_sessions: Default::default(),
        authorization: authorization.clone(),
        readiness: Mutex::new(Readiness {
            checked_at: Instant::now(),
            problem: false,
        }),
    });
    if let Some(service) = &authorization {
        service.set_runtime(Arc::new(ConsoleRuntime(Arc::downgrade(&gateway))))?;
    }
    if gateway.cli.boxed {
        let monitored = Arc::downgrade(&gateway);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(15)).await;
                let Some(gateway) = monitored.upgrade() else {
                    break;
                };
                if gateway.capacity.is_closed() {
                    break;
                }
                let image = gateway.cli.box_image.clone();
                let egress = gateway.cli.egress_container.clone().unwrap();
                let result = tokio::task::spawn_blocking(move || {
                    agent_connect_gateway::sandbox::preflight(&image, &egress)
                })
                .await;
                *gateway.readiness.lock().unwrap() = Readiness {
                    checked_at: Instant::now(),
                    problem: !matches!(result, Ok(Ok(()))),
                };
            }
        });
    }
    let shutdown_gateway = gateway.clone();
    let mut app = Router::new()
        .route("/acp", get(upgrade))
        .route("/healthz", get(health))
        .with_state(gateway);
    if let Some(authorization) = authorization {
        app = app.merge(authorization.router());
    }
    eprintln!("[gateway] listening on ws://{listen}/acp");
    let listener = tokio::net::TcpListener::bind(listen).await.context(
        "gateway listener unavailable; run agent-connect doctor and check listener_port",
    )?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        {
            let _sessions = shutdown_gateway.sessions.lock().unwrap();
            shutdown_gateway.capacity.close();
            shutdown_gateway.shutdown.send_replace(true);
        }
        let mut sessions = std::mem::take(&mut *shutdown_gateway.sessions.lock().unwrap());
        let drain = async {
            shutdown_gateway.hosts.shutdown().await;
            while let Some(result) = sessions.join_next().await {
                if let Err(error) = result {
                    tracing::error!(%error, "session task failed during shutdown");
                }
            }
        };
        if tokio::time::timeout(Duration::from_secs(20), drain).await.is_err() {
            tracing::error!("session shutdown deadline exceeded; aborting remaining tasks with owned-resource cleanup");
            sessions.abort_all();
        }
    })
    .await?;
    Ok(())
}

async fn health(State(gateway): State<Arc<Gateway>>) -> impl axum::response::IntoResponse {
    let readiness = gateway.readiness.lock().unwrap();
    let ready = !readiness.problem
        && (!gateway.cli.boxed || readiness.checked_at.elapsed() < Duration::from_secs(60))
        && !gateway.capacity.is_closed()
        && !gateway
            .hosts
            .session_views()
            .iter()
            .any(|session| session.state == "cleanup-failed");
    drop(readiness);
    let ready = ready
        && gateway
            .authorization
            .as_ref()
            .is_none_or(|auth| auth.healthy());
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        [
            ("cache-control", "no-store"),
            ("x-content-type-options", "nosniff"),
        ],
        axum::Json(serde_json::json!({
            "status": if ready { "ok" } else { "unavailable" },
            "ready": ready,
            "version": env!("CARGO_PKG_VERSION"),
            "repair": if ready { None } else { Some("Run agent-connect doctor") },
        })),
    )
}

async fn upgrade(
    State(gateway): State<Arc<Gateway>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let ws = ws
        .max_message_size(MAX_CLIENT_FRAME_BYTES)
        .max_frame_size(MAX_CLIENT_FRAME_BYTES);
    let origin = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if gateway.authorization.is_none() && origin != gateway.cli.allow_origin {
        eprintln!("[gateway] reject {peer}: origin {origin:?}");
        return ws
            .protocols([RESUME_SUBPROTOCOL, ACP_SUBPROTOCOL])
            .on_upgrade(|mut socket| async move {
                close_with(&mut socket, 4403, "origin not allowed").await;
            });
    }
    let offered: Vec<&str> = headers
        .get_all("sec-websocket-protocol")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(',').map(str::trim))
        .collect();
    let grant = offered.iter().find_map(|protocol| {
        protocol
            .strip_prefix(BEARER_PREFIX)
            .and_then(|token| gateway.authenticate(token, origin, &headers))
    });
    let Some(grant) = grant else {
        eprintln!("[gateway] reject {peer}: invalid or expired app grant");
        return ws
            .protocols([RESUME_SUBPROTOCOL, ACP_SUBPROTOCOL])
            .on_upgrade(|mut socket| async move {
                close_with(&mut socket, 4401, "unauthorized").await;
            });
    };
    let resumable = offered.contains(&RESUME_SUBPROTOCOL);
    if !resumable && !offered.contains(&ACP_SUBPROTOCOL) {
        eprintln!("[gateway] reject {peer}: no supported subprotocol");
        return ws
            .protocols([RESUME_SUBPROTOCOL, ACP_SUBPROTOCOL])
            .on_upgrade(|mut socket| async move {
                close_with(&mut socket, 4401, "unauthorized").await;
            });
    }
    let selected = if resumable {
        RESUME_SUBPROTOCOL
    } else {
        ACP_SUBPROTOCOL
    };
    ws.protocols([selected])
        .on_upgrade(move |socket| async move {
            if let Err(e) = serve_socket(socket, gateway, peer, grant, resumable).await {
                eprintln!("[gateway] {peer} ended with error: {e}");
            }
        })
}

fn frame_capacity_error(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        if error
            .downcast_ref::<tungstenite::Error>()
            .is_some_and(|error| matches!(error, tungstenite::Error::Capacity(_)))
        {
            return true;
        }
        current = error.source();
    }
    false
}

/// One WebSocket: attach it to a new or existing host and pump frames until
/// either side goes away.
async fn serve_socket(
    mut socket: WebSocket,
    gateway: Arc<Gateway>,
    peer: SocketAddr,
    grant: GrantContext,
    resumable: bool,
) -> anyhow::Result<()> {
    let (host, ack) = if resumable {
        let first = tokio::time::timeout(Duration::from_secs(10), socket.recv()).await;
        let text = match first {
            Ok(Some(Ok(Message::Text(text)))) => text,
            Ok(Some(Err(error))) if frame_capacity_error(&error) => {
                close_with(&mut socket, 1009, "client frame exceeds 1 MiB").await;
                return Ok(());
            }
            _ => return Ok(()),
        };
        let attach: Value = serde_json::from_str(&text).unwrap_or_default();
        if attach.get("t").and_then(Value::as_str) != Some("attach") {
            close_with(&mut socket, close::BAD_FRAME, "expected attach").await;
            return Ok(());
        }
        let ack = attach.get("ack").and_then(Value::as_u64).unwrap_or(0);
        match attach.get("resume").and_then(Value::as_str) {
            Some(token) => match gateway.hosts.find(token, &grant.id) {
                Some(host) => (host, ack),
                None => {
                    eprintln!("[gateway] {peer} reattach refused: unknown or ended host");
                    let _ = socket
                        .send(Message::Text(r#"{"t":"expired"}"#.into()))
                        .await;
                    close_with(&mut socket, close::EXPIRED, "expired").await;
                    return Ok(());
                }
            },
            None => {
                let Some(host) = start_or_close(&mut socket, &gateway, &grant, true, peer).await
                else {
                    return Ok(());
                };
                (host, 0)
            }
        }
    } else {
        let Some(host) = start_or_close(&mut socket, &gateway, &grant, false, peer).await else {
            return Ok(());
        };
        (host, 0)
    };

    let (generation, mut outbound) = match host.attach(ack) {
        Ok(attached) => attached,
        Err(AttachError::Expired) => {
            if host.wait_for_completion(Duration::from_secs(15)).await {
                let _ = socket
                    .send(Message::Text(r#"{"t":"expired"}"#.into()))
                    .await;
                close_with(&mut socket, close::EXPIRED, "expired").await;
            } else {
                close_with(&mut socket, close::EVICTED, "session cleanup unconfirmed").await;
            }
            return Ok(());
        }
    };

    let mut authorization_check = tokio::time::interval(Duration::from_secs(1));
    let mut ping = tokio::time::interval(Duration::from_secs(10));
    let mut last_heard = Instant::now();
    let mut replies = Vec::new();
    let why = loop {
        tokio::select! {
            frame = socket.recv() => {
                last_heard = Instant::now();
                if !gateway.access_active(&grant) {
                    let code = if gateway.grant_active(&grant.id) { 4401 } else { 4414 };
                    close_with(&mut socket, code, "authorization ended").await;
                    break "authorization ended";
                }
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        if let Err(code) = host.client_text(&gateway.hosts, generation, &text, &mut replies).await {
                            close_with(&mut socket, code, "bad frame").await;
                            break "bad frame";
                        }
                        for reply in replies.drain(..) {
                            if socket.send(Message::Text(reply.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Some(Err(error)) if frame_capacity_error(&error) => {
                        host.kill("frame too large");
                        close_with(&mut socket, 1009, "client frame exceeds 1 MiB").await;
                        break "frame too large";
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break "socket closed",
                    Some(Ok(_)) => {}
                }
            }
            out = outbound.recv() => match out {
                _ if !gateway.access_active(&grant) => {
                    let code = if gateway.grant_active(&grant.id) { 4401 } else { 4414 };
                    close_with(&mut socket, code, "authorization ended").await;
                    break "authorization ended";
                },
                Some(ToSocket::Text(text)) => {
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break "send failed";
                    }
                }
                Some(ToSocket::Close(code, reason)) => {
                    close_with(&mut socket, code, reason).await;
                    break reason;
                }
                None => break "host gone",
            },
            _ = authorization_check.tick() => {
                if !gateway.access_active(&grant) {
                    let code = if gateway.grant_active(&grant.id) { 4401 } else { 4414 };
                    close_with(&mut socket, code, "authorization ended").await;
                    break "authorization ended";
                }
            }
            _ = ping.tick() => {
                if last_heard.elapsed() > Duration::from_secs(25) {
                    break "no pong";
                }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break "ping failed";
                }
            }
        }
    };
    eprintln!(
        "[gateway] {peer} attachment {generation} of host {} ended: {why}",
        host.label
    );
    host.detach(generation);
    Ok(())
}

async fn close_with(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}

/// Track allocation before its first await: graceful shutdown must also collect
/// sessions whose Docker resources exist before their ACP host is registered.
async fn start_host(
    gateway: &Arc<Gateway>,
    grant: &GrantContext,
    resumable: bool,
    peer: SocketAddr,
) -> anyhow::Result<Arc<Host>> {
    let permit = gateway
        .capacity
        .clone()
        .try_acquire_owned()
        .map_err(|_| anyhow::anyhow!("session capacity reached"))?;
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    {
        let mut sessions = gateway.sessions.lock().unwrap();
        if gateway.capacity.is_closed() {
            anyhow::bail!("gateway is shutting down");
        }
        while let Some(result) = sessions.try_join_next() {
            if let Err(error) = result {
                tracing::error!(%error, "session task failed");
            }
        }
        let gateway = gateway.clone();
        let grant = grant.clone();
        sessions.spawn(async move {
            let mut ready = Some(ready_tx);
            if let Err(error) = run_host(gateway, grant, resumable, peer, permit, &mut ready).await
            {
                if let Some(ready) = ready {
                    let _ = ready.send(Err(error));
                } else {
                    tracing::error!(%error, "session task failed");
                }
            }
        });
    }
    ready_rx.await.context("session startup task ended")?
}

async fn run_host(
    gateway: Arc<Gateway>,
    grant: GrantContext,
    resumable: bool,
    peer: SocketAddr,
    permit: tokio::sync::OwnedSemaphorePermit,
    ready: &mut Option<tokio::sync::oneshot::Sender<anyhow::Result<Arc<Host>>>>,
) -> anyhow::Result<()> {
    let label = uuid::Uuid::new_v4().to_string();
    let session_dir = gateway.cli.state_dir.join("sessions").join(&label);
    std::fs::create_dir_all(&session_dir)?;
    eprintln!(
        "[gateway] {peer} new {} host {label}; live hosts {}",
        if resumable { "resumable" } else { "plain" },
        gateway.hosts.live_hosts() + 1
    );
    let boxed = gateway.cli.boxed;
    let (mut network, agent, permit) = if boxed {
        let session = label.clone();
        let egress = gateway.cli.egress_container.clone().unwrap();
        let mock = gateway.cli.mock_container.clone();
        let mode = grant
            .permissions
            .codex_mode(gateway.cli.codex_mode.unwrap());
        let image = gateway.cli.box_image.clone();
        let harness = gateway.cli.harness;
        let home = gateway.home.clone();
        let volume = gateway.cli.durable_home.then(|| home_volume(&grant.id));
        let mocked = gateway.cli.mock_root.is_some();
        // Startup rollback and Docker CLI calls belong off the async executor.
        let (network, args) = tokio::task::spawn_blocking(move || {
            let mut network =
                SessionNetwork::create(&session, &egress, mock.as_deref(), &image, permit)?;
            let args = box_args(
                harness,
                &session,
                mode.as_str(),
                volume.as_deref(),
                home.as_ref(),
                &image,
                &network.name,
                mocked,
            );
            match network.create_box(args) {
                Ok(args) => Ok((network, args)),
                Err(error) => {
                    if let Err(cleanup) = network.cleanup_blocking() {
                        tracing::error!(%cleanup, "session box startup rollback failed");
                    }
                    Err(error)
                }
            }
        })
        .await??;
        match AcpAgent::from_args(args) {
            Ok(agent) => (Some(network), agent, None),
            Err(error) => {
                if let Err(cleanup) = network.cleanup().await {
                    tracing::error!(%cleanup, "session adapter startup rollback failed");
                }
                return Err(error.into());
            }
        }
    } else {
        (
            None,
            mock_harness(
                &gateway.paths,
                gateway.cli.harness,
                &gateway.cli.mock_url,
                grant
                    .permissions
                    .codex_mode(gateway.cli.codex_mode.unwrap())
                    .as_str(),
            ),
            Some(permit),
        )
    };
    let policy = PolicyProxy::new(PolicyConfig {
        workspace: if boxed {
            "/work".into()
        } else {
            session_dir.clone()
        },
        app_server_name: "app".into(),
        snapshot: Some(grant.snapshot.clone()),
        tool_definitions: grant.tool_definitions.clone(),
        permissions: grant.permissions,
        grant_sessions: grant.sessions.clone(),
        actions_dir: Some(gateway.cli.state_dir.join("actions")),
    });
    let mut components = ProxiesAndAgent::new(agent).proxy(policy);
    if !boxed {
        components = components.proxy(McpOverAcpPolyfill::http());
    }
    let chain = ConductorImpl::new_agent("agent-connect-gateway", components);
    let host = {
        let _sessions = gateway.sessions.lock().unwrap();
        if gateway.capacity.is_closed() {
            None
        } else {
            Some(
                gateway
                    .hosts
                    .create_with_cleanup(&grant.id, resumable, label.clone()),
            )
        }
    };
    let Some((host, io)) = host else {
        if let Some(network) = network {
            if let Err(error) = network.cleanup().await {
                tracing::error!(%error, "session shutdown startup rollback failed");
            }
        }
        anyhow::bail!("gateway is shutting down");
    };
    let mut shutdown = gateway.shutdown.subscribe();
    if ready.take().unwrap().send(Ok(host.clone())).is_err() {
        host.kill("socket ended during startup");
    }
    let _permit = permit; // Boxed capacity is held by its resource owner.
    let started = Instant::now();
    let result = tokio::select! {
        result = chain.connect_to(Lines::new(io.outgoing, io.incoming)) => Some(result),
        _ = shutdown.wait_for(|stopped| *stopped) => None,
        _ = async {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            loop {
                interval.tick().await;
                if !gateway.grant_active(&grant.id) {
                    host.kill("grant revoked or expired");
                    break;
                }
            }
        } => None,
    };
    eprintln!(
        "[gateway] chain {label} ended after {:?}: {:?}",
        started.elapsed(),
        result.as_ref().and_then(|result| result.as_ref().err())
    );
    let cleanup_ok = if let Some(network) = network.take() {
        match network.cleanup().await {
            Ok(()) => true,
            Err(error) => {
                tracing::error!(%error, "session Docker cleanup failed");
                false
            }
        }
    } else {
        true
    };
    drop(_permit);
    host.complete_cleanup(cleanup_ok);
    Ok(())
}

/// A volume name derived from the grant, never containing the token itself.
fn home_volume(grant: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("acp-home-{:x}", Sha256::digest(grant.as_bytes()))
}

async fn start_or_close(
    socket: &mut WebSocket,
    gateway: &Arc<Gateway>,
    grant: &GrantContext,
    resumable: bool,
    peer: SocketAddr,
) -> Option<Arc<Host>> {
    match start_host(gateway, grant, resumable, peer).await {
        Ok(host) => Some(host),
        Err(error) => {
            eprintln!("[gateway] session launch failed: {error}");
            let code = if gateway.capacity.available_permits() == 0 {
                4418
            } else {
                4500
            };
            close_with(socket, code, "session unavailable").await;
            None
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn grant_volume_name_is_release_stable_sha256() {
        assert_eq!(
            super::home_volume("abc"),
            "acp-home-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(super::home_volume("abc"), super::home_volume("abd"));
    }
}
