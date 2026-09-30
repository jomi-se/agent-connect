# ADR 0016: ACP application boundary and consent-enforcing ACP gateway

Date: 2026-09-30. Status: **proposed**, not accepted. If accepted, it would
supersede the application wire of [ADR 0010](0010-open-responses-gateway-pivot.md)
and the execution host of [ADR 0015](0015-openclaw-plugin-host.md). Until then,
both remain in force, and so does AGENTS.md's installation guidance.

Evidence: [ACP gateway spike results](../experiments/acp-gateway.md).

## Context

Agent Connect lets an application borrow the agent its user already has. The
user brings the agent; the application brings the UI and its own tools, under
scoped, revocable consent.

The current release does not deliver that for coding harnesses:

- The Agent Connect plugin delegates execution to OpenClaw's `/v1/responses`.
  In OpenClaw 2026.9.1, caller-supplied Responses tools work only on the
  built-in runtime, so the managed agent was pinned to it.
- Native tools are denied and sandboxing is off. Applications therefore reach
  a model loop with their own tools, not Codex or Claude Code with their
  capabilities.
- OpenClaw's alternatives do not close the gap. Plugin tool names are fixed in
  the installed manifest. Outbound MCP connections carry no session identity.
  An active OpenClaw sandbox disables Codex's user MCP servers.

The deeper mismatch: Open Responses models an application tool as the end of a
turn, while harnesses call tools inside their loop.

The Agent Client Protocol (ACP) is the protocol editors use to drive
user-owned agents, which is Agent Connect's relationship. Since ADR 0010 it has
gained what a web application needs:

- remote HTTP/WebSocket transport (active since 2026-07-02);
- MCP-over-ACP, through which a client offers its own tools over the
  connection (unstable);
- proxy chains;
- official Rust and TypeScript SDKs;
- maintained adapters for Codex, Claude Code and other harnesses.

## Proposed decision

1. **Application wire: ACP over WebSocket.** Applications speak ACP v1 and
   offer their tools as one MCP-over-ACP server, declared in session setup.
   MCP-over-ACP is unstable and is labeled so in every public API and
   document.
2. **Agent Connect is a consent-enforcing ACP proxy.**
   - It authorizes at connection time: an exact `Origin`, and a grant-bound
     bearer token offered as a WebSocket subprotocol.
   - Its policy proxy is default-deny in both directions. It uses only generic
     ACP and MCP-over-ACP messages, and owns every authority-bearing field:
     client capabilities, `cwd`, MCP server declarations, mode and model.
   - It admits application tools only against the consented snapshot.
   - It answers harness permission prompts from the gateway profile, never
     through the application.
   - It restricts session load and resume to sessions the grant created.
3. **Execution: unmodified ACP adapters.** The owner selects the harness.
   Adapters run behind the official MCP-over-ACP polyfill. No adapter is
   forked or patched.
4. **Isolation: one disposable container per session.** The box holds the
   polyfill and the adapter. Its only network exit is an egress proxy that
   refuses private, reserved, metadata and tailnet destinations. Inside the
   box the harness may use its native tools freely: the box, not permission
   prompts, bounds native actions.
5. **Implementation.** The gateway is Rust, on the official ACP Rust SDK. The
   browser SDK stays TypeScript, on `@agentclientprotocol/sdk`.
6. **Unchanged principles.** Owner consent with OAuth/PKCE, revocable grants,
   immutable tool snapshots, stable action IDs, no automatic replay of
   ambiguous effects, and no claim of exactly-once execution.

## Consequences

Gains:

- Applications get the owner's real harness, with its web search, code
  execution and model, next to their own tools.
- Tools reach the model under their real names and schemas.
- Any ACP harness can sit behind the gateway without a translation layer.
- Progress rendering uses generic ACP `session/update` items.

Costs and risks:

- Applications lose drop-in Open Responses and AI SDK compatibility.
  Direct-provider paths, such as Bookhand's direct Open Responses connection,
  remain separate.
- The product depends on an unstable MCP-over-ACP RFD, and on MCP protocol
  generations interoperating (spike finding 3).
- OpenClaw leaves the execution path. The installation and hosting story, and
  AGENTS.md's "no separate process" rule, need a separate decision.
- Harness tool calls have a default ceiling of about 300 s. Long human waits
  need progress notifications or a receipt-and-follow-up pattern.
- Per-session images are large (about 2 GB unpacked), although runtime cost is
  small (about 0.6–1.5 s start, 80–190 MiB per session).

## Prerequisites before acceptance

- **Credential boundary.** Launch harnesses with purpose-built configuration
  while using the owner's subscription login without copying it or exposing it
  to the harness's shell, and without breaking refresh-token rotation for the
  owner's other sessions.
- **Hosting and installation.** What the owner installs and runs, and how it
  relates to OpenClaw, which could remain one optional host.
- **Consent code.** Port the OAuth/PKCE consent, grant and revocation code, or
  keep it as a separate component.
- **Session isolation.** A per-session internal network, and durable session
  storage so boxed sessions can resume.
- **Migration.** A plan for Bookhand and Firebase Canvas, and an SDK
  MCP-server helper that answers unknown methods with method-not-found and
  sends progress while it waits.

## Alternatives considered

- **Keep Open Responses through OpenClaw's built-in loop.** This is the status
  quo, a model loop without harness capabilities.
- **Upstream harness-neutral client tools in OpenClaw.** A larger upstream
  feature; it would still bridge a turn-ending wire to in-loop tools.
- **OpenClaw MCP route with a session-identity header.** A small upstream ask
  that gives real tool names, but conflicts with OpenClaw disabling Codex MCP
  servers inside a sandbox.
- **Return to Omnigent.** Its July spike proved the MCP relay, but it is a
  private session API that ACP now standardizes.
- **AG-UI.** It is widely adopted, but it models the application developer's
  own agent, and its frontend tools end the turn like Responses.
