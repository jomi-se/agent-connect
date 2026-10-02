// Phase 4: browser-facing ACP gateway.
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
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_client_protocol::AcpAgent;
use agent_client_protocol::{ConnectTo, Lines};
use agent_client_protocol_conductor::{ConductorImpl, ProxiesAndAgent};
use agent_client_protocol_polyfill::mcp_over_acp::McpOverAcpPolyfill;
use agent_connect_gateway::credentials::{HarnessHome, login_args};
use agent_connect_gateway::policy::{GrantSessions, PermissionProfile, PolicyConfig, PolicyProxy};
use agent_connect_gateway::resume::{
    self, AttachError, Host, RESUME_SUBPROTOCOL, Registry, ResumeConfig, ToSocket, close,
};
use agent_connect_gateway::sandbox::{SessionNetwork, box_args};
use agent_connect_gateway::{Harness, SpikePaths, mock_harness};
use axum::Router;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use clap::{Args, Parser, Subcommand};
use serde_json::Value;

const ACP_SUBPROTOCOL: &str = "acp.v1";
const BEARER_PREFIX: &str = "bearer.";

#[derive(Parser)]
#[command(version, about = "Unreleased, unstable ACP application gateway")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Serve(ServeCli),
    Login(LoginCli),
}
#[derive(Args)]
struct LoginCli {
    #[arg(long, value_enum)]
    harness: Harness,
    #[arg(long)]
    harness_home: std::path::PathBuf,
    #[arg(long, default_value = "agent-connect-session:0.1.0")]
    session_image: String,
}
#[derive(Args, Clone)]
struct ServeCli {
    #[arg(long, value_enum)]
    harness: Harness,
    #[arg(long, default_value = "127.0.0.1:18940")]
    listen: SocketAddr,
    /// Exact browser origin allowed to connect.
    #[arg(long)]
    allow_origin: String,
    /// Operator-issued grant bearer. OAuth grant issuance remains a release prerequisite.
    #[arg(long)]
    token: String,
    /// Consented tool list (array of {name, inputSchema}); the snapshot.
    #[arg(long)]
    tools: std::path::PathBuf,
    #[arg(long, default_value = "http://127.0.0.1:18931/v1")]
    mock_url: String,
    #[arg(long, default_value = "workspace-write")]
    codex_mode: String,
    #[arg(long, value_enum, default_value = "sandboxed")]
    permissions: PermissionProfile,
    /// Dedicated shared home: credentials, configuration and transcripts together.
    #[arg(long)]
    harness_home: Option<std::path::PathBuf>,
    #[arg(long, default_value = "agent-connect-session:0.1.0")]
    session_image: String,
    /// Container running the egress proxy; connected to each internal session network.
    #[arg(long)]
    egress_container: Option<String>,
    /// Isolated deterministic fixture root. Host launches are never production isolation.
    #[arg(long)]
    mock_root: Option<std::path::PathBuf>,
    /// Deterministic boxed fixtures only: model container, with no provider login.
    #[arg(long)]
    mock_container: Option<String>,
    #[arg(long, default_value = ".agent-connect/gateway")]
    state_dir: std::path::PathBuf,
    #[arg(long, default_value_t = 32)]
    max_sessions: usize,
    /// Run each connection's adapter and polyfill in its own container.
    #[arg(long)]
    boxed: bool,
    /// How long a detached resumable host keeps running.
    #[arg(long, default_value_t = 600)]
    resume_grace_secs: u64,
    /// Boxed only: keep each grant's harness home in a named Docker volume,
    /// so conversations survive their boxes.
    #[arg(long)]
    durable_home: bool,
    /// Unacknowledged output a resumable host may retain before it is ended.
    #[arg(long, default_value_t = 8 * 1024 * 1024)]
    resume_max_bytes: usize,
}

struct Gateway {
    cli: ServeCli,
    home: Option<HarnessHome>,
    capacity: Arc<tokio::sync::Semaphore>,
    /// The spike has one development grant, so one session registry.
    grant_sessions: GrantSessions,
    snapshot: BTreeMap<String, Value>,
    paths: SpikePaths,
    hosts: Arc<Registry>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let mut cli = match Cli::parse().command {
        Command::Serve(cli) => cli,
        Command::Login(cli) => {
            let home = HarnessHome::prepare(&cli.harness_home)?;
            if matches!(cli.harness, Harness::Claude) {
                eprintln!(
                    "Claude Code usage through Agent Connect is unconfirmed against Anthropic terms."
                );
            }
            let status = std::process::Command::new("docker")
                .args(login_args(&home, &cli.session_image, cli.harness))
                .status()?;
            anyhow::ensure!(status.success(), "provider login helper failed");
            return Ok(());
        }
    };
    anyhow::ensure!(
        cli.boxed || cli.mock_root.is_some(),
        "production sessions require --boxed; host mode requires an isolated --mock-root"
    );
    anyhow::ensure!(
        !cli.boxed || cli.egress_container.is_some(),
        "--boxed requires --egress-container"
    );
    anyhow::ensure!(
        cli.harness_home.is_none() || cli.boxed,
        "--harness-home requires --boxed"
    );
    anyhow::ensure!(
        cli.mock_container.is_none() || cli.mock_root.is_some(),
        "--mock-container requires --mock-root"
    );
    anyhow::ensure!(
        !cli.boxed || cli.mock_root.is_some() || cli.harness_home.is_some(),
        "production boxes require a dedicated --harness-home"
    );
    anyhow::ensure!(
        !cli.token.is_empty() && cli.max_sessions > 0,
        "grant token and positive session capacity required"
    );
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
    let paths = SpikePaths {
        root: cli
            .mock_root
            .clone()
            .unwrap_or_else(|| std::path::PathBuf::from(".")),
    };
    let tools: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&cli.tools)?)?;
    let mut snapshot = BTreeMap::new();
    for tool in tools {
        let name = tool
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("snapshot tool name required"))?;
        let schema = tool
            .get("inputSchema")
            .filter(|s| s.is_object())
            .ok_or_else(|| anyhow::anyhow!("snapshot tool schema required"))?;
        anyhow::ensure!(
            snapshot.insert(name.to_string(), schema.clone()).is_none(),
            "duplicate snapshot tool"
        );
    }
    let listen = cli.listen;
    let hosts = Registry::new(ResumeConfig {
        grace: Duration::from_secs(cli.resume_grace_secs),
        max_retained_bytes: cli.resume_max_bytes,
    });
    let gateway = Arc::new(Gateway {
        hosts,
        home,
        capacity: Arc::new(tokio::sync::Semaphore::new(cli.max_sessions)),
        cli,
        snapshot,
        paths,
        grant_sessions: Default::default(),
    });
    let shutdown_gateway = gateway.clone();
    let app = Router::new()
        .route("/acp", get(upgrade))
        .with_state(gateway);
    eprintln!("[gateway] listening on ws://{listen}/acp");
    let listener = tokio::net::TcpListener::bind(listen).await?;
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
        shutdown_gateway.hosts.shutdown().await;
    })
    .await?;
    Ok(())
}

async fn upgrade(
    State(gateway): State<Arc<Gateway>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let ws = ws.max_message_size(1024 * 1024).max_frame_size(1024 * 1024);
    let origin = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if origin != gateway.cli.allow_origin {
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
    let grant = offered.iter().find_map(|p| {
        p.strip_prefix(BEARER_PREFIX)
            .filter(|t| resume::constant_time_eq(t.as_bytes(), gateway.cli.token.as_bytes()))
    });
    let Some(grant) = grant.map(str::to_string) else {
        eprintln!("[gateway] reject {peer}: bad bearer");
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

/// One WebSocket: attach it to a new or existing host and pump frames until
/// either side goes away.
async fn serve_socket(
    mut socket: WebSocket,
    gateway: Arc<Gateway>,
    peer: SocketAddr,
    grant: String,
    resumable: bool,
) -> anyhow::Result<()> {
    let (host, ack) = if resumable {
        let first = tokio::time::timeout(Duration::from_secs(10), socket.recv()).await;
        let Ok(Some(Ok(Message::Text(text)))) = first else {
            return Ok(());
        };
        let attach: Value = serde_json::from_str(&text).unwrap_or_default();
        if attach.get("t").and_then(Value::as_str) != Some("attach") {
            close_with(&mut socket, close::BAD_FRAME, "expected attach").await;
            return Ok(());
        }
        let ack = attach.get("ack").and_then(Value::as_u64).unwrap_or(0);
        match attach.get("resume").and_then(Value::as_str) {
            Some(token) => match gateway.hosts.find(token, &grant) {
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
            let _ = socket
                .send(Message::Text(r#"{"t":"expired"}"#.into()))
                .await;
            close_with(&mut socket, close::EXPIRED, "expired").await;
            return Ok(());
        }
    };

    let mut ping = tokio::time::interval(Duration::from_secs(10));
    let mut last_heard = Instant::now();
    let mut replies = Vec::new();
    let why = loop {
        tokio::select! {
            frame = socket.recv() => {
                last_heard = Instant::now();
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
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break "socket closed",
                    Some(Ok(_)) => {}
                }
            }
            out = outbound.recv() => match out {
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

/// Creates a host and runs its chain in the background.
fn start_host(
    gateway: &Arc<Gateway>,
    grant: &str,
    resumable: bool,
    peer: SocketAddr,
) -> anyhow::Result<Arc<Host>> {
    let label = uuid::Uuid::new_v4().to_string();
    let permit = gateway
        .capacity
        .clone()
        .try_acquire_owned()
        .map_err(|_| anyhow::anyhow!("session capacity reached"))?;
    let session_dir = gateway.cli.state_dir.join("sessions").join(&label);
    std::fs::create_dir_all(&session_dir)?;
    eprintln!(
        "[gateway] {peer} new {} host {label}; live hosts {}",
        if resumable { "resumable" } else { "plain" },
        gateway.hosts.live_hosts() + 1
    );
    let (host, io) = gateway.hosts.create(grant, resumable, label.clone());

    let boxed = gateway.cli.boxed;
    let network = if boxed {
        Some(SessionNetwork::create(
            &label,
            gateway.cli.egress_container.as_deref().unwrap(),
            gateway.cli.mock_container.as_deref(),
        )?)
    } else {
        None
    };
    let agent = if let Some(network) = &network {
        let volume = gateway.cli.durable_home.then(|| home_volume(grant));
        AcpAgent::from_args(box_args(
            gateway.cli.harness,
            &label,
            &gateway.cli.codex_mode,
            volume.as_deref(),
            gateway.home.as_ref(),
            &gateway.cli.session_image,
            &network.name,
            gateway.cli.mock_root.is_some(),
        ))?
    } else {
        mock_harness(
            &gateway.paths,
            gateway.cli.harness,
            &gateway.cli.mock_url,
            &gateway.cli.codex_mode,
        )
    };
    let policy = PolicyProxy::new(PolicyConfig {
        workspace: if boxed {
            "/work".into()
        } else {
            session_dir.clone()
        },
        app_server_name: "app".into(),
        snapshot: Some(gateway.snapshot.clone()),
        permissions: gateway.cli.permissions,
        grant_sessions: gateway.grant_sessions.clone(),
        actions_dir: Some(session_dir.join("actions")),
    });
    let mut components = ProxiesAndAgent::new(agent).proxy(policy);
    if !boxed {
        components = components.proxy(McpOverAcpPolyfill::http());
    }
    let chain = ConductorImpl::new_agent("agent-connect-gateway", components);
    tokio::spawn(async move {
        let _permit = permit;
        let _network = network;
        let started = Instant::now();
        let result = chain.connect_to(Lines::new(io.outgoing, io.incoming)).await;
        eprintln!(
            "[gateway] chain {label} ended after {:?}: {:?}",
            started.elapsed(),
            result.as_ref().err()
        );
    });
    Ok(host)
}

/// A volume name derived from the grant, never containing the token itself.
fn home_volume(grant: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    grant.hash(&mut hasher);
    format!("acp-home-{:016x}", hasher.finish())
}

async fn start_or_close(
    socket: &mut WebSocket,
    gateway: &Arc<Gateway>,
    grant: &str,
    resumable: bool,
    peer: SocketAddr,
) -> Option<Arc<Host>> {
    match start_host(gateway, grant, resumable, peer) {
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
