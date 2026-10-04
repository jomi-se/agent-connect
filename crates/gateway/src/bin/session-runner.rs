// Phase 6: runs inside a per-session container. Speaks ACP on stdio to the
// host gateway and owns the in-box part of the chain:
//
//   stdio <- conductor [ McpOverAcpPolyfill ] -> adapter (child process)
//
// Keeping the polyfill in the box means its loopback HTTP MCP bridge is only
// reachable from inside the same network namespace as the harness.

use agent_client_protocol::{AcpAgent, ConnectTo, Stdio};
use agent_client_protocol_conductor::{ConductorImpl, ProxiesAndAgent};
use agent_client_protocol_polyfill::mcp_over_acp::McpOverAcpPolyfill;
use agent_connect_gateway::Harness;
use clap::Parser;

#[derive(Parser)]
struct Cli {
    #[arg(long, value_enum)]
    harness: Harness,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    // The box provides both adapters on PATH and harness configuration via
    // environment set by the container entrypoint.
    let adapter = match cli.harness {
        Harness::Codex => "codex-acp",
        Harness::Claude => "claude-agent-acp",
    };
    let agent = AcpAgent::from_args([adapter])?;
    let chain = ConductorImpl::new_agent(
        "agent-connect-box",
        ProxiesAndAgent::new(agent).proxy(McpOverAcpPolyfill::http()),
    );
    chain.connect_to(Stdio::new()).await?;
    Ok(())
}
