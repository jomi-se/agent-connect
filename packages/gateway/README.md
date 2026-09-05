# Agent Connect gateway

The gateway is the narrow application-delegation boundary in front of an
operator-configured OpenClaw service. It exposes gateway-owned authorization,
opaque application sessions (`POST /v1/app-sessions`), the bounded Open
Responses endpoint (`POST /v1/responses`) and namespaced response controls.
It is not a general OpenClaw reverse proxy or a harness supervisor.

The replacement is implemented on a separate branch. Runtime selection, final
subscription/browser validation and live cutover remain gated by
[ADR 0012](../../docs/decisions/0012-openclaw-policy-gateway.md) and the
[replacement contract](../../docs/plan/openclaw-replacement.md).

## Operator setup

Use the [OpenClaw gateway guide](../../deploy/openclaw-gateway/README.md) for
pinned dependency prerequisites, the private environment file, startup checks,
the runtime boundary and safe migration. The launcher connects to an already
running OpenClaw service; it does not install a model, link credentials, choose
a harness or restart the upstream.

Required configuration:

| Variable                                | Meaning                                                        |
| --------------------------------------- | -------------------------------------------------------------- |
| `OPENCLAW_BASE_URL`                     | Operator-selected upstream base URL; no implicit default       |
| `OPENCLAW_TOKEN`                        | Server-only upstream credential                                |
| `OPENCLAW_AGENT_ID`                     | Explicit operator-selected upstream agent                      |
| `AGENT_CONNECT_STATE_PATH`              | Owner-only gateway identity/grant state                        |
| `AGENT_CONNECT_PUBLIC_ENDPOINT`         | Enrolled HTTPS gateway endpoint                                |
| `AGENT_CONNECT_ALLOWED_TAILSCALE_USERS` | Allowed Tailscale owner identities                             |
| `AGENT_CONNECT_TRANSPORT_PROFILE`       | Use `tailscale-serve` for the supported private remote profile |

`AGENT_CONNECT_DYNAMIC_APP_ENROLLMENT=1` enables consent bootstrap for
previously unknown HTTPS Origins under the Tailscale Serve profile.
`AGENT_CONNECT_ALLOWED_ORIGINS` remains an optional stricter Origin policy;
without dynamic enrollment, at least one allowed Origin is required.
`AGENT_CONNECT_RESPONSE_STATE_PATH` optionally selects the response ledger
directory; otherwise it is `responses` beside the auth state file.

The gateway listener defaults to `http://127.0.0.1:8787`. Keep it on loopback;
Tailscale Serve terminates HTTPS and supplies authenticated identity headers.
Publication and service supervision are operator-owned and not changed by
the launcher.

The upstream token never belongs in browser configuration, a frontend
environment, a URL or the SDK. Agent Connect constructs fresh upstream
headers with operator-pinned agent selection and a private stable session key.
It forwards only the bounded request profile and re-injects approved tools on
every segment. Applications cannot select upstream routing, models or host
tools.

The selected runtime must disable host shell/filesystem/network/MCP tools for
application delegation. This is operator/runtime policy, not an OS sandbox
created by request filtering. Omnigent launch settings, workspace cleanup,
Codex-home options and the old Bubblewrap environment are not part of this
gateway's supported configuration.

## Enrollment and authorization

For a new identity only, the one-shot initializer exports a runtime card and
generated enrollment secret as separate outputs. Save the secret privately.
It persists only a salted verifier and refuses to overwrite existing state;
normal serving refuses uninitialized state. Import only the public card into
the app and enter the passphrase only on the gateway-owned consent page.

The application verifies a fresh signed challenge before disclosing its tools,
then uses S256 PKCE to obtain a revocable Origin/app/tool-bound grant. Dynamic
enrollment is not ambient agent access: Tailscale authenticates the configured
owner, the gateway page requires consent, the redirect stays on the initiating
Origin, and operational requests require the exact approved authority.
Originless clients additionally require the grant's explicit non-browser
consent and the owner-transport checks.

Applications can revoke their own grant through bearer-authenticated
`POST /oauth/revoke`; its response deliberately does not reveal whether the
submitted token existed. Owner grant listing and administrative revocation
remain on `/v1/grants`. Normal per-application authorization does not require
SSH, terminal access or restart.

## Selecting a session

The credential decides which session a request means:

| Credential         | `POST /v1/app-sessions` means                        |
| ------------------ | ---------------------------------------------------- |
| Application grant  | Create a new independent session, always             |
| Session capability | Refresh exactly the session named by that capability |
| Neither            | `401`; no implicit session selection                 |

A grant never selects the newest matching tab or conversation. The gateway
allocates a private OpenClaw session key for each opaque application session;
neither this key nor raw provider routes enter the browser API. Capability
refresh does not provision, heal or replace the upstream conversation.

An application that wants to reconnect must retain its session capability and
continuation checkpoint. A client that kept nothing starts a new session.
A lost session-creation response followed by a grant retry creates another
session; the orphan counts against capacity and expires normally. There is no
implicit adoption or client-supplied session-creation idempotency mechanism.

The accepted `fresh` request field is redundant and deprecated: a grant already
means create. It remains rejected alongside a session capability.

## Responses and recovery

The public model selector remains `agent-connect/default`. OpenClaw owns
inference, history, compaction and Responses generation; the gateway owns
application/session/call authority, the latest admitted checkpoint and durable
publication. One response can be admitted per application session, while
independent sessions may run concurrently.

Calls are recorded before any corresponding tool publication. Output attempts
are recorded before upstream submission. Identical retries cannot redeliver an
output; conflicting outputs are rejected. Ambiguous upstream acceptance is
reported as interrupted rather than replayed automatically. Applications still
own side-effect idempotency; no generic exactly-once guarantee is made.

Control extensions are:

- `GET /v1/agent-connect/responses/:id`: inspect the owned recorded checkpoint
  and its recovery outcome;
- `GET /v1/agent-connect/responses/:id/pending-function-calls`: inspect only
  calls whose continuation is known to remain possible;
- `POST /v1/agent-connect/responses/:id/cancel`: enforce local cancellation.

Upstream response IDs are not capabilities. Local ownership and latest-head
checks are independent of OpenClaw's cache, and explicit private routing avoids
implicit conversation adoption. A gateway restart reconstructs response-bearing
sessions from durable authority records; in-flight uncertain work becomes
interrupted. A newly issued session with no durable response chain is not
reconstructed. The SDK does not automatically retrieve pending calls or replay
transcripts.

The pinned built-in OpenClaw loop supports the tested client-tool round trip,
but projects returned output as user text after a synthetic delegated result,
not as native tool-role continuation. The separately packaged native Codex
adapter drops client tools. Final selected-subscription/browser evidence is
still required; built-in-loop tests must not be called native Codex support.
See the [dependency investigation](../../docs/research/2026-09-05-openclaw-replacement.md).

## Session lifetime

Lifetime slides with activity, governed by three separate clocks:

| Variable                                     | Default seconds | Retirement boundary                                  |
| -------------------------------------------- | --------------- | ---------------------------------------------------- |
| `AGENT_CONNECT_SESSION_IDLE_TIMEOUT_SECONDS` | 900             | No request and no work in progress for this long     |
| `AGENT_CONNECT_PARKED_CALL_TIMEOUT_SECONDS`  | 180             | Published function call remains unanswered           |
| `AGENT_CONNECT_RUNNING_TURN_TIMEOUT_SECONDS` | 1800            | Total upstream request time, even if events continue |

An unanswered parked call and an abandoned tab are indistinguishable after
the segment ends; these are declared lifetime policies, not browser-presence
detection.

`AGENT_CONNECT_CAPABILITY_TTL_SECONDS` defaults to 3600 and controls signed
capability validity separately. A still-valid capability naming a retired
session receives `401 {"error":"session_expired"}`, indicating that the client
must start over rather than merely refresh its token.

Client disconnect, cancellation, expiry and revocation restrict further local
publication/admission. They do not independently prove upstream generation has
stopped. The API/console describe upstream stop as unconfirmed, and OpenClaw's
operator-configured timeout must bound resource lifetime. Runtime-specific
disconnect evidence is separate from that local guarantee.

## Owner session console

`GET /sessions` uses the same owner-only trusted path as `/authorize` and
`/v1/grants`. It shows live session state, turn count, last activity and local
retirement timing, plus recent ended sessions from the durable ledger.
Interrupted sessions are labeled explicitly. Cumulative usage and runner
liveness are unavailable through this boundary; the console does not invent
zero cost or confirmed process termination.

`POST /sessions` with a `session` field retires local authority and frees its
capacity slot. It does not delete an upstream workspace or claim that a harness
process was terminated. Applications refused capacity receive `429`,
`Retry-After` and a `manageUrl` pointing to this page.

## Persistence and migration

Gateway keys, enrolled-device hashes, grant hashes, revocations and capability
signing state retain their existing durable format. Response/call ownership and
private routing for response-bearing sessions are durable too. Pending consent
requests, authorization codes and rate-limit counters remain process-local.

Preserve the existing identity and original state for rollback; do not
reinitialize or rotate it during backend migration. Old Omnigent conversations
are explicitly interrupted, never reinterpreted as OpenClaw sessions. Use a
separate replacement response-ledger path as described in the setup guide and
create fresh application sessions. Neither these source changes nor the
launcher authorizes a live cutover.
