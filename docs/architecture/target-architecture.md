# Target architecture

## Component map

```text
browser application
  @agent-connect/web
  define tools, run task, events, confirm app-owned mutations
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
  requested/configured posture + observations
  input event allowlist + resource ceilings
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
application-owned mutation confirmation, and reconnection orchestration. It
cannot approve connector filesystem, shell, network, MCP, policy, or harness
permission requests. It does not know OmniGENT or Codex message shapes. AG-UI is
the leading pending candidate for standard run, message, and frontend-tool
payloads; the existing ACP/MCP browser prototype remains experimental until the
comparison spike is decided.

The current package still exports `OmnigentProvider`, `connectOmnigent`, and
OmniGENT option types from the spike. Those are transitional provider entry
points, not the intended default public integration. The neutral `connectAgent`
and task/tool types are the target application surface.

### Gateway

Owns enrollment, authorization, mapping application sessions to OmniGENT conversations,
request-scoped tool-schema injection, normalized events, and durable pending
application actions. Its provider interface contains no browser-facing
OmniGENT types.

The enrolled profile prints one runtime card and generated high-entropy
enrollment passphrase on first state creation. The user saves the bundle in a
password manager, imports only the public card into applications, and enters
the passphrase only on the connector origin. The application accepts the
destination only after it proves possession of the enrolled connector key.

Each new application then redirects to a top-level connector-owned OAuth
authorization page. Tailscale authenticates the requesting user to that page;
the connector shows and approves the exact browser Origin, application id,
tool metadata snapshot (name, description, and input schema), requested scopes,
callback, and expiry. This binds declared authority, not the application-side
handler implementation, which remains app code. The connector returns a
short-lived code protected by PKCE and issues a revocable bearer grant. An
app-instance key and DPoP-style sender binding remain target hardening.
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

An authenticated application remains untrusted. The gateway selects a
connector-owned runtime posture that the application cannot broaden and reports
its configuration, claim source, and relevant observations. The runtime adapter
implements the filesystem, network, persistence, credential, and sandbox
mechanics. The target reference profile exposes only the approved application tool snapshot
in an empty isolated workspace, removes ambient integrations, and denies local
escalation and tool network access. Application result events and connector
approval events use separate protocols and credentials. See the
[control-plane/runtime decision](../decisions/0008-control-plane-and-runtime-confinement-boundary.md)
and [malicious-application threat model](../research/2026-07-14-malicious-application-runtime-threat-model.md).

The deployed gateway listens only on loopback. Tailscale Serve terminates HTTPS
and supplies authenticated identity headers; the gateway checks those headers
and an exact application Origin allowlist before accepting a session request.
Firebase hosts application assets, not the gateway or the user-owned runtime.

### OmniGENT

Owns normalized conversation state, downstream harness processes, policy,
streaming, and the selected agent environment for the reference connector. Its
adapter owns the concrete sandbox, filesystem, network, persistence, native
tool, credential, and approval integration. OmniGENT's sandbox and policy
features are enforcement layers, not a generic guarantee: the connector must
report their configured state and observable behavior and separately account
for MCP subprocesses and harness-native capabilities. A direct Codex process
running as the connector's VM user is ambient host execution, regardless of
what the connector calls the profile. It must not delegate
system-of-record responsibility to Codex session files.

The first VM-local `linux_bwrap` profile verifies its outer boundary with a
guard, read-only workspace, dedicated writable Codex home, host sentinel,
`NoNewPrivs`, and seccomp. Its dynamic tool loop is currently blocked by the
OmniGENT-to-Codex MCP child startup under that boundary, so it is experimental,
not the default demonstrated profile. It also leaves a copied Codex credential
visible to a network-capable `agent-full-access` process; credential brokerage
or whole-runner containment with controlled egress is required before this can
defend against a malicious app. See the
[sandbox spike](../research/2026-07-14-omnigent-vm-sandbox-spike.md).

The leading pending deployment alternative packages the gateway, connector UI,
OmniGENT control plane and runner, Codex adapter, and dynamic relay as an
Internet-connectable container appliance. Its first profile uses a shared
appliance with gateway-owned ephemeral session workspaces; the stronger target
creates a separate runner container per downstream session. This can simplify
installation and remove host-specific Bubblewrap composition, but it does not
by itself solve agent-credential exfiltration or human authorization on a
public endpoint. See the
[containerized appliance plan](../plan/containerized-connector-appliance.md).

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
