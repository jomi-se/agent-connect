# Narrow experimental ACP/MCP-over-ACP profile

This profile defines the narrow ACP and MCP-over-ACP wire boundary enforced
between `@open-agent-connect/web` and the gateway's policy proxy. ACP,
MCP-over-ACP and `agent-connect.resume.v1` remain unstable; this is not full
protocol conformance.

## Topology

- one authenticated WebSocket (`acp.v1` or `agent-connect.resume.v1`);
- one ACP client and gateway policy-proxy chain per session host;
- one agent session per grant-scoped conversation;
- one `McpServerAcp` supplied by the application;
- one active MCP connection for that server;
- a fixed, consented tool snapshot for the grant lifetime.

## Allowed ACP methods

The gateway's policy proxy is default-deny in both directions and owns every
authority-bearing field (`clientCapabilities`, `cwd`, MCP server declarations,
mode and model):

- `initialize`
- `session/new`
- `session/load` and `session/resume` (restricted to sessions created under the
  same grant and entry-point address)
- `session/prompt`
- `session/cancel`
- `session/update`
- `session/request_permission` (answered by the gateway from the consented
  permission profile, never forwarded to the application)
- `mcp/connect`, `mcp/message`, `mcp/disconnect`

## Allowed nested MCP messages

- Requests to application: `initialize`, `ping`, `tools/list`, `tools/call`
- Notifications to application: `notifications/initialized`,
  `notifications/cancelled`
- Notifications from application: `notifications/cancelled`,
  `notifications/progress`

Resources, prompts, logging, completion, sampling, elicitation, subscriptions,
pagination and multiple logical servers are not admitted.

## Resumption and reconnect boundary

- **In-flight transport resumption (`agent-connect.resume.v1`):** Gateway-owned
  session hosts outlive dropped WebSockets for a bounded grace period and
  output buffer. Every ACP message travels in a sequence-numbered envelope
  (`attach`/`attached`/`m`/`a`/`p`/`P`/`bye`); reattaching with the same grant,
  origin and resume token resends unacknowledged frames in both directions and
  deduplicates by sequence. Plain `acp.v1` clients keep per-socket sessions.
- **Action journaling:** Before dispatching `tools/call` to the application,
  the gateway persists the request in its action journal and attaches a stable
  `agent-connect/actionId`. Handlers must be idempotent or deduplicate on that
  ID; cancellation and disconnect cannot undo an effect that already ran.
- **Ended sessions:** Past the grace or retention bound, or after a gateway
  restart, the client falls back to ACP `session/load` (`provider.recover()`),
  restoring conversation history and reporting interruption without ever
  automatically replaying uncertain prompts or application effects.

## Rejection behavior

The policy proxy drops undeclared or schema-drifted tools on `tools/list` and
rejects unapproved calls on `tools/call`. The browser SDK rejects:

- unknown server IDs on `mcp/connect`;
- a second active logical connection;
- unknown or closed connection IDs;
- MCP messages before initialization where required;
- unsupported MCP methods;
- malformed or unknown tool calls.

Errors are machine-readable and never fall back to executing another tool.
