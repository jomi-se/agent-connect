# Target architecture

## Component map

```text
browser application
  @agent-connect/web
  define tools, run task, events, approve
             |
             | Firebase HTTPS origin -> Tailscale Serve HTTPS
             v
Agent Connect gateway
  one-time pairing + scoped application capabilities
  exact Origin (+ Tailscale identity in direct mode)
  logical -> provider session mapping and health recovery
  pending-action persistence
  fixed tool snapshot + provider adapter
             |
             | OmniGENT HTTP/SSE Sessions API
             | request-scoped client tools
             v
OmniGENT conductor
  normalized sessions, policy, harness lifecycle
             |
             | generic ACP harness
             v
@agentclientprotocol/codex-acp
             |
             | Codex app-server
             v
Codex
```

## Ownership boundaries

### Web SDK

Owns browser transport setup, ACP client handlers, application tool registration, the single MCP server implementation, application approval hooks, and reconnection orchestration. It does not know OmniGENT or Codex message shapes.

### Gateway

Owns pairing, authorization, mapping application sessions to OmniGENT conversations,
request-scoped tool-schema injection, normalized events, and durable pending
application actions. Its provider interface contains no browser-facing
OmniGENT types.

The gateway prints a one-time pairing code to its local operator channel. A
browser proves possession once and receives an expiring signed capability. The
capability is audience-bound to the requesting Origin, application id, opaque
Agent Connect session id, and canonical tool snapshot. Origin and CORS checks
are defense in depth, not proof of the user.

The gateway provisions a provider session on first use. A healthy provider
session with the same origin, application id, and tool hash is reused. A
different tool hash creates a different downstream ACP session; an unhealthy
matching session is replaced behind the same opaque application session.

The deployed gateway listens only on loopback. Tailscale Serve terminates HTTPS
and supplies authenticated identity headers; the gateway checks those headers
and an exact application Origin allowlist before accepting a session request.
Firebase hosts application assets, not the gateway or the user-owned runtime.

### OmniGENT

Owns normalized conversation state, downstream harness processes, policy, streaming, and the selected agent environment. It must not delegate system-of-record responsibility to Codex session files.

### Application

Owns the actual side effect. It receives a stable action ID and must make consequential operations idempotent or journal their result. The conductor cannot infer whether an unacknowledged external side effect succeeded.

## Tool-call translation

```text
1. Browser registers a fixed tool snapshot while creating the application session.
2. Gateway validates, canonically hashes, authorizes, and records the snapshot.
3. Gateway provisions and binds a healthy OmniGENT runner for that snapshot.
4. OmniGENT provider attaches the schemas to the first session message event.
5. Codex calls a tool through OmniGENT's downstream MCP relay.
6. OmniGENT emits action_required.
7. Gateway persists a pending action.
8. Gateway sends the normalized tool call to the browser.
9. Browser approves and executes the application handler.
10. Gateway posts the correlated tool result to OmniGENT.
11. Codex resumes and completes the turn.
```

## Fallback architecture

If the proven OmniGENT path regresses or blocks the browser slice, replace the
provider with a Codex app-server dynamic-tool adapter. The application API and
pending-action broker remain unchanged.

## Deferred ACP adapter

ACP-over-WebSocket plus MCP-over-ACP remains the preferred future standardized
wire candidate. It implements the same gateway/application API after the first
working browser slice; it is not required to demonstrate the hackathon product.
