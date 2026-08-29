# Target architecture

This page contains an "aspirational" target architecture that would be the end goal of this project.

## Component map

```text
browser application
  Open Responses client or @agent-connect/web convenience SDK
  define functions, create/continue responses, execute app-owned changes
             |
             | Open Responses HTTP/SSE
             | OAuth-protected gateway grant
             v
Agent Connect gateway
  enrolled gateway identity and exact application-function consent
  shared Open Responses transport, state, and recovery core
  response chain -> harness session mapping and health recovery
  fixed function snapshot + bundled harness backend
  requested/configured posture + observations
  input allowlist + resource ceilings
             |
             | backend-specific launch and response translation
             v
Codex / Claude Code / another coding harness
  model loop, context, runtime-owned tools
```

This proposed target is described by
[ADR 0010](../decisions/0010-open-responses-gateway-pivot.md). The existing
Omnigent -> ACP -> Codex chain remains the proven implementation baseline until
the Open Responses compatibility and authorization gates pass.

## Ownership boundaries

### Web SDK

Owns browser transport setup, application function registration and execution,
application-owned mutation confirmation, and response-chain orchestration. It
cannot approve gateway filesystem, shell, network, MCP, policy, or harness
permission requests. It does not know Omnigent or Codex message shapes. Open
Responses is the request, item, streaming, function-call, function
output, continuation, and error vocabulary. AG-UI is an optional future edge
adapter rather than the core boundary; the ACP/MCP browser prototype remains
experimental.

The package exposes the neutral `connectAgent` and task/tool types. The former
browser-visible Omnigent provider and direct session routes have been removed;
Omnigent is confined to the gateway's bundled backend.

### Gateway

Owns enrollment, authorization, Open Responses transport and state correctness,
mapping response chains to harness sessions, request-scoped function policy,
and pending-call recovery. A bundled harness backend owns both response
translation and the supervisor mechanics required by its harness. The target
does not introduce an independently deployed facade-to-supervisor protocol.
Durable pending application actions are a required next reliability layer, not
current behavior. Its public interface contains no browser-facing Omnigent,
Codex, ACP, or MCP types.

An explicit one-shot initializer prints one runtime card and generated
high-entropy enrollment passphrase on first state creation. It persists only a
salted verifier and refuses to re-export or overwrite an existing identity;
normal gateway startup refuses uninitialized state and never receives the
plaintext passphrase. The user saves the bundle in a password manager, imports
only the public card into applications, and enters the passphrase only on the
gateway origin. The application accepts the
destination only after it proves possession of the enrolled gateway key.

Each new application then redirects to a top-level gateway-owned OAuth
authorization page. Tailscale authenticates the requesting user to that page;
the gateway shows and approves the exact browser Origin, application id,
tool metadata snapshot (name, description, and input schema), requested scopes,
callback, and expiry. This binds declared authority, not the application-side
handler implementation, which remains app code. The gateway returns a
short-lived code protected by PKCE and issues a revocable bearer grant. An
app-instance key and DPoP-style sender binding remain target hardening.
Normal authorization does not require terminal access or gateway restart.
See [ADR 0007](../decisions/0007-runtime-card-and-gateway-authorization.md).

An application Origin does not need to be configured when the gateway
starts. A previously unknown HTTPS Origin may initiate only the bounded
authorization bootstrap. Approval creates a durable, scoped application grant
binding that exact Origin, redirect URI, application id, scopes, and tool
snapshot; it does not add the host to a global trust list. Session, prompt,
result, and tool traffic remain unavailable until that grant exists. Dynamic
CORS decisions follow the same boundary: bootstrap endpoints may reflect the
validated initiating Origin, while protected endpoints require an active grant
bound to that Origin. An environment-based Origin allowlist remains an
optional stricter operator policy.

Direct URLs and relay addresses are transport hints, not runtime identity. See
the [mutual runtime identity investigation](../research/2026-07-14-mutual-runtime-identity.md)
and [trusted transport profile decision](../decisions/0005-trusted-transport-profiles.md).

The first remote profile is Tailscale Serve. Tailscale authenticates node
transport and supplies requester identity to the loopback gateway, but an
ordinary hosted page cannot inspect the destination node key or owner directly.
First-use enrollment therefore binds the selected Serve endpoint to an Agent
Connect gateway key; later handshakes verify that key. Recognizing a `.ts.net`
hostname is never sufficient evidence by itself.

The gateway provisions a provider session on first use. A healthy provider
session with the same origin, application id, and tool hash is reused. A
different tool hash creates a different downstream ACP session; an unhealthy
matching session is replaced behind the same opaque application session.

An authenticated application remains untrusted. The gateway selects a
gateway-owned runtime posture that the application cannot broaden and reports
its configuration, claim source, and relevant observations. The runtime adapter
implements the filesystem, network, persistence, credential, and sandbox
mechanics. The target hardened profile exposes only the approved application
tool snapshot in an empty OS-isolated workspace, removes ambient integrations,
and denies local escalation and tool network access. The current
source-installable Codex profile uses a fresh dedicated directory per session,
but that directory is not yet an OS confidentiality boundary. It records the
grant-bound tool names in a mode-`0600` session manifest. An internal
compatibility adapter converts that manifest into Codex MCP `enabled_tools`
plus per-tool approval settings. This preapproves only the browser tools the
user already consented to; Omnigent's built-in MCP tools and all other MCP tools
remain unavailable or approval-gated. Application result events and gateway
approval events use separate protocols and credentials. See the
[control-plane/runtime decision](../decisions/0008-control-plane-and-runtime-confinement-boundary.md)
and [malicious-application threat model](../research/2026-07-14-malicious-application-runtime-threat-model.md).

The deployed gateway listens only on loopback. Tailscale Serve terminates HTTPS
and supplies authenticated identity headers. The gateway checks those headers
and requires an exact Origin-bound application grant before accepting a session
request. Firebase hosts application assets, not the gateway or the user-owned
runtime.

### Omnigent

Owns normalized conversation state, downstream harness processes, policy,
streaming, and the selected agent environment for the reference gateway. Its
adapter owns the concrete sandbox, filesystem, network, persistence, native
tool, credential, and approval integration. Omnigent's sandbox and policy
features are enforcement layers, not a generic guarantee: the gateway must
report their configured state and observable behavior and separately account
for MCP subprocesses and harness-native capabilities. A direct Codex process
running as the gateway's VM user is ambient host execution, regardless of
what the gateway calls the profile. It must not delegate
system-of-record responsibility to Codex session files.

The first VM-local `linux_bwrap` profile verifies its outer boundary with a
guard, read-only workspace, dedicated writable Codex home, host sentinel,
`NoNewPrivs`, and seccomp. Its dynamic tool loop is currently blocked by the
Omnigent-to-Codex MCP child startup under that boundary, so it is experimental,
not the default demonstrated profile. It also leaves a copied Codex credential
visible to a network-capable `agent-full-access` process; credential brokerage
or whole-runner containment with controlled egress is required before this can
defend against a malicious app. See the
[sandbox spike](../research/2026-07-14-omnigent-vm-sandbox-spike.md).

The leading pending deployment alternative packages the gateway, gateway UI,
Omnigent control plane and runner, Codex adapter, and dynamic relay as an
Internet-connectable container appliance. Its first profile uses a shared
appliance with gateway-owned ephemeral session workspaces; the stronger target
creates a separate runner container per downstream session. This can simplify
installation and remove host-specific Bubblewrap composition, but it does not
by itself solve agent-credential exfiltration or human authorization on a
public endpoint. See the
[containerized deployment plan](../plan/containerized-gateway-deployment.md).

### Application

Owns the actual side effect. It receives a stable action ID and must make
consequential operations idempotent or journal their result. The gateway cannot
infer whether an unacknowledged external side effect succeeded.

## Tool-call translation

```text
1. Browser registers a fixed tool snapshot while creating the application session.
2. Gateway validates, canonically hashes, authorizes, and records the snapshot.
3. Gateway writes the exact authorized tool names into a private session policy manifest.
4. Gateway provisions and binds a healthy Omnigent runner for that snapshot.
5. The internal Codex adapter enables and preapproves only those granted relay tools.
6. Omnigent provider attaches the schemas to the first session message event.
7. Codex calls a tool through Omnigent's downstream MCP relay.
8. Omnigent emits action_required.
9. Gateway sends the normalized tool call to the browser.
10. Browser executes the application-owned handler and returns its result.
11. Gateway posts the correlated tool result to Omnigent.
12. Codex resumes and completes the turn.
```

The target recovery layer inserts durable `pending`, `delivered`, `applied`,
and `acknowledged` state before step 9. That layer is not implemented, so a
disconnect can still lose an unresolved tool request.

## Fallback architecture

If the proven Omnigent path regresses or blocks the browser slice, replace the
provider with a Codex app-server dynamic-tool adapter. The application API and
future pending-action contract remain unchanged.

## Deferred ACP adapter

ACP remains an optional harness-facing adapter where its stable session and
client capabilities fit. It is not the proposed application-facing wire, and
unstable MCP-over-ACP is not required by the Open Responses target.

## Deprioritized AG-UI application adapter

AG-UI remains relevant for applications that specifically need its shared UI
state, activity, or ecosystem integrations. Open Responses already covers the
core Agent Connect prompt, streaming, function-call, function-output, and
continuation requirements, so AG-UI is no longer the leading application
boundary. If later implemented, it should adapt at the edge to the Open
Responses gateway rather than create a second core execution model. See the
[AG-UI investigation](../research/2026-07-14-ag-ui-fit.md), the earlier
[compatibility spike](../plan/ag-ui-compatibility-spike.md), and
[ADR 0010](../decisions/0010-open-responses-gateway-pivot.md).
