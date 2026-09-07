# Current architecture and remaining acceptance boundary

[ADR 0014](../decisions/0014-stock-openclaw-scoped-proxy.md) selects a trusted
authorization proxy in front of the published, unmodified OpenClaw Responses
endpoint. The parent native-patch experiment is preserved but not required.

## Component map

```text
application / browser
  @open-agent-connect/web or a bounded Responses client
  application-owned functions and origin-bound grant
                 |
                 | OAuth/PKCE + bounded POST /v1/responses
                 v
Agent Connect scoped proxy
  explicit owner login and consent
  grant, policy, tool-snapshot and response-id authority
  fresh server-owned routing + private operator bearer
                 |
                 | loopback stock Responses + private session key
                 v
published unpatched OpenClaw
  inference, history, native tools, sandbox and subscription credentials
```

The proxy is not an agent runtime or a general OpenClaw reverse proxy. It exposes
only discovery, OAuth, owner login, Responses creation, scoped cancellation and
health. It does not expose catalogs, configuration, arbitrary URLs or admin APIs.

## Ownership boundaries

### Application and SDK

The application owns its functions and side effects. It must make consequential
operations idempotent or deduplicate with stable call IDs; a lost acknowledgement
does not prove whether an external effect occurred. Existing discovery,
OAuth/PAR/S256 PKCE, refresh/revoke and AI SDK integration remain unchanged.

The public v0 request profile accepts text user input, correlated
`function_call_output`, the exact consented tools, optional bounded generation
controls, streaming/nonstreaming creation and explicit `previous_response_id`.
Media, remote inputs, `user`, metadata, background work, caller routing and
unknown fields are rejected before upstream admission.

### Owner and application authority

Gateway initialization prints one enrollment secret and persists only its salted
scrypt verifier. An owner enters that secret on the gateway-hosted login page;
the gateway stores only a random hashed browser-session token and returns it as
an HttpOnly, Secure, SameSite cookie. Tailscale may carry HTTPS traffic, but
membership and forwarding headers are not owner proof.

The owner then reviews the exact Origin, callback, scopes, tools and fixed policy.
The issued bearer is bound to client Origin, resource, grant authorization
version, policy fingerprint, agent and tool hash. Refresh changes the bearer but
not that authorization identity; revocation removes authority immediately.

### Request construction and conversations

The proxy validates the caller request, then constructs a new upstream body. It
always re-injects the approved functions and sends only content type, accept, the
private operator bearer, the configured agent and a random lowercase private
session key. It follows no redirects and sends the credential only to an explicit
loopback origin. Caller cookies, forwarding identity, OpenClaw scope/model/agent/
session headers and unknown parameters never cross this boundary.

A bounded in-memory registry maps the latest completed upstream response ID to
the exact grant/policy/conversation tuple and pending call IDs. A continuation
must answer exactly those calls where present, then consumes its predecessor
before the upstream POST. Sibling or replacement grants cannot borrow it.
Mappings expire after 30 minutes and are capped at 1,024 total/eight per grant by
default. Restart, expiry, revocation, policy change, failed streams and ambiguous
disconnects end continuation. The proxy never finds the newest operator session,
reconstructs a transcript or replays a possibly admitted mutation.

### Event boundary

Stock OpenClaw creates Responses objects and events. The proxy preserves SSE bytes,
framing, order and backpressure while parsing one bounded frame at a time to
observe response IDs, terminal state and function-call names/IDs. An unapproved
function item is rejected before its first event is published. A completed
mapping is installed only after the upstream reaches EOF; terminal frames are
held until then to avoid racing stock session finalization. Nonstreaming bodies
are bounded and inspected before publication. Private upstream bodies and errors
are replaced by small public failures.

### OpenClaw and static policy

OpenClaw owns execution, conversation history, compaction, native tool behavior,
sandbox setup and all subscription/provider credentials. The proxy uses only its
public native `POST /v1/responses`; no OpenClaw core patch or plugin is installed.

One private stock config pins local mode, loopback port, exact operator token,
Responses enablement and reload-off. Each offered policy names a dedicated agent
with an absolute isolated workspace, one primary model/no fallback, no bootstrap,
context injection, skills or memory, and an exact native tool ceiling. Elevation
and dynamic tool search are globally disabled. Native code additionally requires
a per-session no-egress Docker/Podman sandbox with no host binds and read-only or
absent host workspace access.

The proxy hashes the complete OpenClaw and policy files at startup and before
admission. Any edit fails closed. This is a supervised static contract, not an
atomic proof of the running process: the operator must stop both processes,
replace config, restart OpenClaw and the proxy, then obtain fresh consent. Running
OpenClaw under another config with the same token/port is unsupported.

## Evidence and deferred work

Deterministic tests use the integrity-pinned published OpenClaw package and replace
only inference. They cover operator-origin native-tool denial, fail-closed sandbox
startup, real SDK/OAuth owner consent, two application calls/results, contextual
follow-up, refresh/revoke and authority attacks. They do not prove the selected
subscription model, HTTPS ingress, supervisor configuration or Bookhand UI.

The earlier native extension, custom Responses engine and durable response ledger
remain historical experiments. They are not linked or built by
`npm run build:scoped-proxy`, and their compatibility tests are not part of
`npm run verify:scoped-proxy`. No direct-Codex fallback, generalized orchestration,
arbitrary MCP surface or second proprietary session protocol is introduced.
