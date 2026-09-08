# Stock OpenClaw plugin host

The reference installation is `@agent-connect/openclaw-plugin`. Stock OpenClaw
2026.9.1 loads the package, owns its routes and starts/stops its managed service.
The service reuses the same scoped request, grant, continuation and native-output
inspection implementation as the standalone baseline. It forwards bounded
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

The path-based discovery locations follow RFC 8414 and RFC 9728 by inserting
the well-known suffix between the host and issuer/resource path. Native
`/v1/responses`, `/health`, the dashboard, and other plugin routes remain owned
by OpenClaw. The application credential is valid only for the namespaced
resource and fails at native Responses.

## State and lifecycle

Owner identity and delegated grants live below the OpenClaw state directory in
`agent-connect/`. The initial setup command prints the enrollment passphrase
once and stores only its verifier. Conversation/checkpoint authority remains
bounded and process-local. Stop, disable, reload, or restart refuses new work,
aborts owned streams, clears continuations, and never replays an uncertain
application operation.

The plugin service does not wait synchronously for a native route that starts
later in gateway startup. It stays unavailable while a bounded readiness probe
checks the authenticated native endpoint. Configuration and the relevant policy
fingerprint are rechecked before every admission and continuation.

This is still not an atomic fence against a trusted operator changing runtime
configuration between the final snapshot check and the internal HTTP request.
Supported reconfiguration is controlled disable/change/restart/reconsent.

## Supported coexistence matrix

The initial verified profile is intentionally narrow:

| Configuration                                                           | Status                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------- |
| Published OpenClaw `2026.9.1`; Node `>=24.15 <25`                       | Supported pin                                            |
| Resolved literal `gateway.auth.mode: token`                             | Supported                                                |
| Password, SecretRef, no-auth, or trusted-proxy gateway authority        | Unsupported                                              |
| Native TLS on the loopback listener                                     | Unsupported; terminate public HTTPS outside the listener |
| One plugin-managed app-only agent                                       | Supported                                                |
| Native public search or code execution in an offered profile            | Not offered in this slice                                |
| Personal agents, channels, models, credentials, tools, memory, and cron | Preserved and unreachable through the app-only agent     |
| Stock and owner-installed plugins, plugin load paths, and global hooks  | Preserved; inside the trusted user-owned host boundary   |

The managed agent has its own private workspace, `contextInjection: never`, an
empty skills list, disabled cross-conversation memory/search, no sandbox or
elevation, and exact native-tool deny-all. These per-agent controls mean setup
does not turn off the owner's global tools or memory. Setup never overwrites a
conflicting agent id.

Owner-installed plugin and hook code can affect OpenClaw execution, including the
offered agent. Agent Connect does not certify or sandbox the user's host from
itself, and static configuration cannot prove arbitrary hook behavior. The
security boundary enforced here is the hostile calling application: its grant,
tool snapshot, routing and session authority remain bounded. Setup rejects
concrete offered-agent settings that defeat that profile, but it neither audits
nor allowlists trusted host extensions.
