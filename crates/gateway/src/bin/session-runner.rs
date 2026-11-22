// Runs inside a per-session container. Speaks ACP on stdio to the host
// gateway and owns the in-box part of the chain:
//
//   stdio <- conductor -> adapter (child process)
//
// The adapter bridges the application's MCP-over-ACP server itself, on a
// loopback HTTP endpoint only reachable inside the box's network namespace.

use agent_client_protocol::{AcpAgent, ConnectTo, Stdio};
use agent_client_protocol_conductor::{ConductorImpl, ProxiesAndAgent};
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
    let chain = ConductorImpl::new_agent("agent-connect-box", ProxiesAndAgent::new(agent));
    chain.connect_to(Stdio::new()).await?;
    Ok(())
}
