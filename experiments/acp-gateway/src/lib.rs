//! Experimental launch helpers; product implementation lives in crates/gateway.
pub use agent_connect_gateway::*;
use agent_client_protocol::AcpAgent;
/// Phase 7 live smoke: an unmodified adapter on the host using the owner's
/// existing harness login in place (default configuration directories under
/// `HOME`, nothing copied). This is not a security boundary: it exists to prove
/// real-model composition. The adapter starts from an empty environment plus an
/// explicit allowlist, so no variables from the calling session (for example a
/// parent Claude Code session's messaging socket) leak into the harness.
pub fn live_harness(paths: &SpikePaths, harness: Harness, codex_mode: &str) -> AcpAgent {
    let bin = match harness {
        Harness::Codex => paths.root.join("adapters/node_modules/.bin/codex-acp"),
        Harness::Claude => paths.root.join("adapters/node_modules/.bin/claude-agent-acp"),
    };
    let keep = |name: &str| format!("{name}={}", std::env::var(name).unwrap_or_default());
    AcpAgent::from_args([
        "env".into(),
        "-i".into(),
        keep("PATH"),
        keep("HOME"),
        keep("USER"),
        "LANG=C.UTF-8".into(),
        format!("INITIAL_AGENT_MODE={codex_mode}"),
        bin.to_string_lossy().into_owned(),
    ])
    .expect("valid adapter command")
}
