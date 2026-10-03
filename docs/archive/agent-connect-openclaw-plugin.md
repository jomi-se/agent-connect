# Agent Connect plugin for OpenClaw host architecture

The reference installation is `@open-agent-connect/openclaw-plugin`. The Agent Connect plugin
for OpenClaw runs inside the user's OpenClaw host, which starts/stops its managed
service. That service owns one or
more dedicated HTTP listeners on IPv4 loopback (single-entry default
`127.0.0.1:18790`) while native OpenClaw keeps its own listener (commonly
`127.0.0.1:18789`). The service uses
the plugin-owned scoped request, grant, continuation and native-output inspection
implementation. It forwards bounded
requests internally to the same gateway's native `/v1/responses` endpoint with
host-held authority. It is not an agent loop or a second gateway.

## Endpoint layout

For public origin `https://gateway.example`, the application supplies provider
URL `https://gateway.example/agent-connect`.

| Purpose                        | Path                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| Issuer                         | `/agent-connect`                                                   |
| Authorization metadata         | `/.well-known/oauth-authorization-server/agent-connect`            |
| Protected-resource metadata    | `/.well-known/oauth-protected-resource/agent-connect/v1/responses` |
| Owner login                    | `/agent-connect/owner/login`                                       |
| Authorize, PAR, token, revoke  | `/agent-connect/oauth/{authorize,par,token,revoke}`                |
| Application Responses resource | `/agent-connect/v1/responses`                                      |
| Conversations                  | `/agent-connect/v1/conversations`                                  |
| Conversation history           | `/agent-connect/v1/conversations/{id}/history`                     |
| Cancel active response         | `/agent-connect/v1/responses/{id}/cancel`                          |
| Plugin readiness               | `/agent-connect/healthz`                                           |

The plugin listener serves only these metadata paths and the exact
`/agent-connect` path boundary. `/`, `/terminal`, native `/v1/responses`, RPC,
unknown discovery, CONNECT and WebSocket upgrades are absent rather than proxied.
The path-based discovery locations follow RFC 8414 and RFC 9728 by inserting
the well-known suffix between the host and issuer/resource path. Native
`/v1/responses`, `/health`, the dashboard and other host routes remain only on
OpenClaw's listener. The application credential is valid only for the namespaced
resource and fails at native Responses.

One plugin installation may declare multiple transport-neutral entry points.
Each entry point has a stable ID, canonical HTTPS public origin and unique
loopback port. It derives its own issuer and resource from that configured
origin; forwarded host headers never select authority. The entry points share
the restricted agent and authenticated native OpenClaw upstream, but maintain
separate delegated grants, OAuth transactions and process-local conversation
authority. A bearer, authorization code or refresh token issued through one
entry point is invalid at every other listener. Entry-point IDs, origins and
ports must each be unique.

Reverse-proxy metadata is accepted but never treated as authority. `Forwarded`,
`X-Forwarded-*`, provider-specific forwarding and identity headers do not select
the issuer, resource, client, owner, agent, model or session. The plugin derives
those exclusively from reviewed configuration, the exact browser Origin and the
delegated grant. Caller-supplied `X-OpenClaw-*` routing headers are rejected
instead of reaching the native request.

## Admission and resource bounds

One admission controller covers every entry point in the plugin service. It
allows at most 64 active HTTP requests, four active inference requests globally,
two active inference requests per grant and 60 inference starts per minute per
grant. It tracks at most 1,024 grant-rate buckets. Saturation receives an
immediate `429` or `503` with `Retry-After`; there is no in-memory work queue.
Leases are released on completion, rejection, timeout, disconnect, cancellation
and shutdown.

The listener allows 15 seconds for headers and 30 seconds for request receipt;
these timers do not limit response generation or silent SSE intervals. A
Responses request is bounded to 20 MiB and a native response to 8 MiB. Structural
array and SSE-frame bounds are enforced before relay, while transformation text
and instructions may use the total request envelope. Applications may request
up to 65,536 output tokens, subject to the selected model and provider. Native
execution retains its separate 30-minute deadline.

Upstream terminal failures are not transport interruptions. Before relaying a
failed response, the plugin replaces arbitrary provider/runtime text with a
small public classification. A recognizable model-credential failure becomes
`agent_authentication_failed`; every other terminal agent failure becomes
`agent_execution_failed`. Only a stream that actually breaks without a usable
terminal failure remains `proxy_interrupted`. This preserves actionable status
without exposing provider names, credentials, filesystem paths or exception
details.

OAuth requests and codes, passphrase verification, owner-browser sessions,
delegated grants and conversation mappings all have explicit count and expiry bounds. At
most 256 delegated grants are retained; revoked and fully expired grants are
pruned before new approval. Conversation turn count is deliberately not capped:
such a limit would not constrain an authorized application that can start a new
conversation and would unnecessarily break long-running transformations.

## State and lifecycle

Owner identity and delegated grants live below the OpenClaw state directory in
`agent-connect/`. The initial setup command prints the enrollment passphrase
once and stores only its verifier. Conversation/checkpoint authority remains
bounded and process-local. Stop, disable, reload, or restart refuses new work,
aborts owned streams, clears continuations, and never replays an uncertain
application operation.

The backwards-compatible single entry point and a multiple-entry configuration
whose entry point ID is `default` use `delegated-grants.json`. Other entry points
use an ID-namespaced delegated-grant file. This preserves existing grants when
a deployment promotes its original endpoint to `default` while preventing
credential reuse across additional origins.

The plugin service does not wait synchronously for a native route that starts
later in gateway startup. It stays unavailable while a bounded readiness probe
checks the authenticated native endpoint. Configuration and the relevant policy
fingerprint are rechecked before every admission and continuation.

This is still not an atomic fence against a trusted operator changing runtime
configuration between the final snapshot check and the internal HTTP request.
Supported reconfiguration is controlled disable/change/restart/reconsent.

## Verified baseline and runtime policy

CI and the reference deployment pin an exact known-good version for reproducible
evidence.
The published plugin permits OpenClaw 2026.9.1 or newer; there is deliberately
no speculative compatibility matrix or upper version bound.

| Configuration                                                                     | Status                                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Tested/deployed OpenClaw `2026.9.1`; Node `>=24.15 <25`                           | Exact evidence pin                                       |
| Resolved `gateway.auth.mode: token`                                               | Supported                                                |
| Resolved `gateway.auth.mode: password`                                            | Supported                                                |
| Configured token/password SecretRef resolved by the active host                   | Supported; environment-backed password is package-tested |
| `gateway.auth.mode: none`                                                         | Supported with an explicit native-endpoint warning       |
| Trusted-proxy or CLI-only auth override not present in host config                | Unsupported                                              |
| Native TLS on the loopback listener                                               | Unsupported; terminate public HTTPS outside the listener |
| Multiple unique HTTPS origins on separate loopback listeners                      | Supported by one plugin service                          |
| One plugin-managed app-only agent                                                 | Supported                                                |
| Native public search or code execution in an offered profile                      | Not offered in this slice                                |
| Personal agents, channels, models, credentials, tools, memory, and cron           | Preserved and unreachable through the app-only agent     |
| OpenClaw-managed and owner-installed plugins, plugin load paths, and global hooks | Preserved; inside the trusted user-owned host boundary   |

The managed agent has its own private workspace, `contextInjection: never`, an
empty skills list, disabled cross-conversation memory/search, no sandbox or
elevation, wildcard client-tool admission, and exact native-tool deny-all. The
wildcard lets grant-approved application tool names pass through OpenClaw's
caller-supplied Responses-tool surface; it does not restore native tools. The
managed agent is pinned to OpenClaw's built-in runtime because external harness
runtimes may not implement that surface. The pin is agent-local, so these
controls do not change the runtime, tools, or memory of the owner's other host
agents. Setup never overwrites a conflicting agent id.

Owner-installed plugin and hook code can affect OpenClaw execution, including the
offered agent. Agent Connect does not certify or sandbox the user's host from
itself, and static configuration cannot prove arbitrary hook behavior. The
security boundary enforced here is the hostile calling application: its grant,
tool snapshot, routing and session authority remain bounded. Setup rejects
concrete offered-agent settings that defeat that profile, but it neither audits
nor allowlists trusted host extensions.

The plugin obtains the active token/password through OpenClaw's published
gateway-auth resolver and never prints or persists the resolved credential.
Internal HTTP uses the exact resolved token or password as the pinned host's
Bearer credential; internal RPC uses the corresponding public client option.
For explicit `none`, both transports omit credentials rather than retrying or
falling back. This changes no application-facing rule: `/agent-connect` still
requires an Origin-bound delegated bearer grant. With native `none`, other
OpenClaw endpoints are deliberately outside that grant boundary. Exposing the
native port bypasses Agent Connect and may expose the authless native Responses
endpoint. Setup and startup warn in good faith, but the operator's native
security configuration remains out of scope. CLI-only auth overrides are not
represented by the active configuration snapshot and are not claimed as supported.
