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

use agent_client_protocol::{ConnectTo, Lines};
use agent_client_protocol_conductor::{ConductorImpl, ProxiesAndAgent};
use agent_client_protocol_polyfill::mcp_over_acp::McpOverAcpPolyfill;
use agent_connect_gateway::policy::{GrantSessions, PermissionProfile, PolicyConfig, PolicyProxy};
use agent_connect_gateway::resume::{
    self, AttachError, Host, RESUME_SUBPROTOCOL, Registry, ResumeConfig, ToSocket, close,
};
use agent_connect_gateway::{Harness, SpikePaths, boxed_harness, mock_harness};
use axum::Router;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use clap::Parser;
use serde_json::Value;

const ACP_SUBPROTOCOL: &str = "acp.v1";
const BEARER_PREFIX: &str = "bearer.";

#[derive(Parser, Clone)]
struct Cli {
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
    cli: Cli,
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
    let cli = Cli::parse();
    let paths = SpikePaths::from_manifest();
    let tools: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(paths.root.join(&cli.tools))?)?;
    let snapshot = tools
        .iter()
        .filter_map(|t| {
            Some((
                t.get("name")?.as_str()?.to_string(),
                t.get("inputSchema")?.clone(),
            ))
        })
        .collect();
    let listen = cli.listen;
    let hosts = Registry::new(ResumeConfig {
        grace: Duration::from_secs(cli.resume_grace_secs),
        max_retained_bytes: cli.resume_max_bytes,
    });
    let gateway = Arc::new(Gateway {
        hosts,
        cli,
        snapshot,
        paths,
        grant_sessions: Default::default(),
    });
    let app = Router::new()
        .route("/acp", get(upgrade))
        .with_state(gateway);
    eprintln!("[gateway] listening on ws://{listen}/acp");
    let listener = tokio::net::TcpListener::bind(listen).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

async fn upgrade(
    State(gateway): State<Arc<Gateway>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
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
            None => (start_host(&gateway, &grant, true, peer)?, 0),
        }
    } else {
        (start_host(&gateway, &grant, false, peer)?, 0)
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
    let session_dir = gateway.paths.run_dir().join("sessions").join(&label);
    std::fs::create_dir_all(&session_dir)?;
    eprintln!(
        "[gateway] {peer} new {} host {label}; live hosts {}",
        if resumable { "resumable" } else { "plain" },
        gateway.hosts.live_hosts() + 1
    );
    let (host, io) = gateway.hosts.create(grant, resumable, label.clone());

    let boxed = gateway.cli.boxed;
    let agent = if boxed {
        let volume = gateway.cli.durable_home.then(|| home_volume(grant));
        boxed_harness(
            gateway.cli.harness,
            &label,
            &gateway.cli.codex_mode,
            volume.as_deref(),
        )
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
