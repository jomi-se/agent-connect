# Target architecture

## Component map

```text
browser application
  @agent-connect/web
  define tools, run task, events, approve
             |
             | transport trust profile + runtime ID
             | authenticated connector/app session
             | candidate payload: AG-UI
             v
Agent Connect gateway
  enrolled connector identity key
  one-time runtime-card export
  connector-hosted OAuth + key-bound application capabilities
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

Owns browser transport setup, application tool registration and execution,
application approval hooks, and reconnection orchestration. It does not know
OmniGENT or Codex message shapes. AG-UI is the leading pending candidate for
standard run, message, and frontend-tool payloads; the existing ACP/MCP browser
prototype remains experimental until the comparison spike is decided.

### Gateway

Owns pairing, authorization, mapping application sessions to OmniGENT conversations,
request-scoped tool-schema injection, normalized events, and durable pending
application actions. Its provider interface contains no browser-facing
OmniGENT types.

The implemented prototype prints a one-time pairing code to its local operator
channel for an application session. The target uses the operator channel only
to export a stable, non-secret runtime card after generating the connector
identity key. The user saves that card in a password manager and imports it into
new applications. The application addresses the runtime ID and accepts the
destination only after it proves possession of the enrolled connector key.

Each new application then redirects to a top-level connector-owned OAuth
authorization page. Tailscale authenticates the requesting user to that page;
the connector shows and approves the exact browser Origin, app-instance key,
application id, tool snapshot, requested scopes, and expiry. The connector
returns a short-lived code protected by PKCE and issues a key-bound grant.
Normal authorization does not require terminal access or connector restart.
See [ADR 0007](../decisions/0007-runtime-card-and-connector-oauth.md).

Direct URLs and relay addresses are transport hints, not runtime identity. See
the [mutual runtime identity investigation](../research/2026-07-14-mutual-runtime-identity.md)
and [trusted transport profile decision](../decisions/0005-trusted-transport-profiles.md).

The first remote profile is Tailscale Serve. Tailscale authenticates node
transport and supplies requester identity to the loopback connector, but an
ordinary hosted page cannot inspect the destination node key or owner directly.
First-use enrollment therefore binds the selected Serve endpoint to an Agent
Connect connector key; later handshakes verify that key. Recognizing a `.ts.net`
hostname is never sufficient evidence by itself.

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

## Pending AG-UI application adapter

AG-UI appears to match the browser-facing run, streaming, and frontend-defined
tool surface more directly than ACP. It does not replace OmniGENT orchestration
or downstream ACP. The proposed shape is:

```text
browser -- AG-UI + Agent Connect security --> gateway
gateway -- OmniGENT adapter --> OmniGENT -- ACP --> codex-acp --> Codex
```

The gateway retains connector enrollment, per-app authorization, opaque
provider sessions, fixed tool policy, stable action IDs, and durable recovery.
See the [AG-UI investigation](../research/2026-07-14-ag-ui-fit.md) and
[compatibility spike](../plan/ag-ui-compatibility-spike.md).
