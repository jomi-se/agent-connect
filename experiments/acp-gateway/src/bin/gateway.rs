//! Phase 4: browser-facing ACP gateway.
//!
//! One WebSocket per application connection. Each connection gets its own
//! chain and adapter process:
//!
//!   browser --WebSocket(ACP)--> [PolicyProxy -> McpOverAcpPolyfill] -> adapter
//!
//! Browser WebSocket constructors cannot set headers, so the bearer token
//! travels as a subprotocol (`bearer.<token>`) next to the ACP subprotocol,
//! which the server selects. The Origin header is checked against an allowlist;
//! WebSocket upgrades are not protected by CORS.

use std::collections::BTreeMap;
use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use acp_gateway_spike::policy::{GrantSessions, PermissionProfile, PolicyConfig, PolicyProxy};
use acp_gateway_spike::{Harness, SpikePaths, mock_harness};
use agent_client_protocol::{ConnectTo, Lines};
use agent_client_protocol_conductor::{ConductorImpl, ProxiesAndAgent};
use agent_client_protocol_polyfill::mcp_over_acp::McpOverAcpPolyfill;
use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use clap::Parser;
use futures::{SinkExt, StreamExt, future};
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
    #[arg(long, default_value = "http://127.0.0.1:18941")]
    allow_origin: String,
    /// Development bearer token; stands in for an OAuth grant.
    #[arg(long, default_value = "spike-dev-token")]
    token: String,
    /// Consented tool list (array of {name, inputSchema}); the snapshot.
    #[arg(long, default_value = "web/tools.json")]
    tools: std::path::PathBuf,
    #[arg(long, default_value = "http://127.0.0.1:18931/v1")]
    mock_url: String,
    #[arg(long, default_value = "workspace-write")]
    codex_mode: String,
    #[arg(long, value_enum, default_value = "sandboxed")]
    permissions: PermissionProfile,
}

struct Gateway {
    cli: Cli,
    /// The spike has one development grant, so one session registry.
    grant_sessions: GrantSessions,
    snapshot: BTreeMap<String, Value>,
    paths: SpikePaths,
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
    let gateway = Arc::new(Gateway {
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
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    let offered: Vec<&str> = headers
        .get_all("sec-websocket-protocol")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(',').map(str::trim))
        .collect();
    let token_ok = offered.iter().any(|p| {
        p.strip_prefix(BEARER_PREFIX)
            .is_some_and(|t| constant_time_eq(t.as_bytes(), gateway.cli.token.as_bytes()))
    });
    if !offered.contains(&ACP_SUBPROTOCOL) || !token_ok {
        eprintln!("[gateway] reject {peer}: missing ACP subprotocol or bad bearer");
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    ws.protocols([ACP_SUBPROTOCOL])
        .on_upgrade(move |socket| async move {
            if let Err(e) = serve_connection(socket, gateway, peer).await {
                eprintln!("[gateway] {peer} ended with error: {e}");
            }
        })
}

async fn serve_connection(
    socket: WebSocket,
    gateway: Arc<Gateway>,
    peer: SocketAddr,
) -> anyhow::Result<()> {
    let started = Instant::now();
    let session_dir = gateway
        .paths
        .run_dir()
        .join("sessions")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&session_dir)?;
    eprintln!(
        "[gateway] {peer} connected; workspace {}",
        session_dir.display()
    );

    let (ws_tx, ws_rx) = socket.split();
    let outgoing = ws_tx
        .sink_map_err(io::Error::other)
        .with(|line: String| future::ready(Ok::<_, io::Error>(Message::Text(line.into()))));
    let incoming = ws_rx.filter_map(|frame| {
        future::ready(match frame {
            Ok(Message::Text(text)) => Some(Ok(text.to_string())),
            Ok(Message::Close(_)) => None,
            Ok(_) => None,
            Err(e) => Some(Err(io::Error::other(e))),
        })
    });
    let transport = Lines::new(Box::pin(outgoing), Box::pin(incoming));

    let agent = mock_harness(
        &gateway.paths,
        gateway.cli.harness,
        &gateway.cli.mock_url,
        &gateway.cli.codex_mode,
    );
    let policy = PolicyProxy::new(PolicyConfig {
        workspace: session_dir,
        app_server_name: "app".into(),
        snapshot: Some(gateway.snapshot.clone()),
        permissions: gateway.cli.permissions,
        grant_sessions: gateway.grant_sessions.clone(),
    });
    let chain = ConductorImpl::new_agent(
        "agent-connect-gateway",
        ProxiesAndAgent::new(agent)
            .proxy(policy)
            .proxy(McpOverAcpPolyfill::http()),
    );
    let result = chain.connect_to(transport).await;
    eprintln!(
        "[gateway] {peer} disconnected after {:?}: {:?}",
        started.elapsed(),
        result.as_ref().err()
    );
    Ok(())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
