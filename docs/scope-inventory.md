# Scope and capability inventory

Updated: 2026-09-05

This inventory distinguishes implemented replacement behavior from release
acceptance. The OpenClaw implementation is isolated on `work/openclaw-gateway`;
it has not replaced the working personal deployment.
[ADR 0012](decisions/0012-openclaw-policy-gateway.md) defines the current
ownership boundary. The [replacement contract](plan/openclaw-replacement.md)
defines validation and cutover gates.

## Application and SDK

Headless conversation controls and immutable current-document WebMCP discovery
remain implemented, harness-neutral SDK features. Their existing evidence is
tracked in the [headless chat](plan/headless-chat.md) and
[WebMCP](plan/webmcp-tool-source.md) contracts; final browser composition with
the selected OpenClaw subscription runtime remains pending.

| Capability                                        | Status                                               | Current boundary                                                                         |
| ------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Define typed application tools                    | Implemented                                          | Browser-safe definitions; immutable approved snapshot per logical session                |
| Verify gateway before disclosure                  | Implemented                                          | Runtime card pins the Ed25519 key; SDK verifies a fresh signed challenge                 |
| Authorize an HTTPS application without a terminal | Implemented                                          | Gateway consent and S256 PKCE bind Origin, redirect, app ID, scopes and tools            |
| Dynamically enroll a new Origin                   | Implemented for Tailscale Serve                      | Bootstrap grants no operational access before approval                                   |
| Create or explicitly reconnect a session          | Implemented                                          | Grants create independent sessions; capabilities name exactly one opaque session         |
| Stream text, lifecycle and tool activity          | Implemented                                          | Bounded Responses HTTP/SSE and neutral SDK events                                        |
| Return a browser function result and follow up    | Implemented; final subscription/browser gate pending | Latest owned checkpoint; real OpenClaw deterministic inference tests                     |
| Start over without reauthorization                | Implemented                                          | Application grant creates a fresh independent session                                    |
| Revoke application authority                      | Implemented                                          | Grant revocation prohibits subsequent use and tool publication                           |
| Use a standard Responses client                   | Implemented bounded profile                          | Application-facing model remains `agent-connect/default`; unsupported fields fail closed |
| Inspect unresolved function calls                 | Implemented bounded recovery                         | Namespaced GET returns only known continuable calls; SDK does not auto-recover them      |
| Install SDK from a clean package artifact         | Implemented from source                              | Package verification remains separate from npm publication                               |
| Generic exactly-once effects                      | Explicit non-goal                                    | Applications own idempotency/deduplication                                               |
| App-instance sender binding/DPoP                  | Deferred                                             | Current grants and capabilities are scoped bearers                                       |
| Browser ACP/MCP-over-ACP                          | Experimental, not default                            | Draft helpers stay isolated from the supported Responses wire                            |
| AG-UI application adapter                         | Deferred                                             | Optional future edge integration, not a second core protocol                             |

## Gateway and runtime

| Capability                                                       | Status                                  | Current boundary                                                                                               |
| ---------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Mediate OpenClaw Responses                                       | Implemented                             | Allowlisted body and fresh server-side headers; upstream token never goes to apps                              |
| Pin private upstream routing                                     | Implemented                             | Operator agent selection and stable private session key; no app routing passthrough                            |
| Enforce the approved function snapshot                           | Implemented                             | Re-injected every segment; outbound calls checked before publication                                           |
| Persist calls before publication                                 | Implemented                             | Fsync-backed ledger; includes recovery GET and stream publication boundaries                                   |
| Prevent output redrive after uncertain delivery                  | Implemented                             | Durable attempt record precedes network submission; identical/conflicting repeats cannot resend                |
| Enforce independent sessions and latest checkpoints              | Implemented                             | One admitted response per session; no cross-application response/call authority                                |
| Recover after gateway restart                                    | Implemented bounded recovery            | Known state remains inspectable; interrupted acceptance is not silently replayed                               |
| Migrate historical provider state                                | Implemented                             | Auth identity/grants remain readable; Omnigent conversations are explicitly unavailable                        |
| Stop delivery and manage sessions                                | Implemented                             | Owner console, local cancellation, idle/parked/total-request bounds; upstream stopping is separately evidenced |
| Report cumulative usage or runner liveness                       | Unavailable                             | Console reports unknown, not zero cost or confirmed termination                                                |
| Supervise harness processes or translate provider events         | Removed from supported gateway path     | OpenClaw owns execution, Responses generation and runtime state                                                |
| Restrict the selected runtime to application tools               | Required operator profile               | Real inference-boundary observations are required; request shaping alone is not a sandbox                      |
| Harden host confidentiality with an OS sandbox                   | Not claimed                             | Runtime isolation and credential policy remain operator/runtime responsibilities                               |
| Support native Codex client-tool execution                       | Blocked in the pinned published adapter | Built-in-loop success must not be presented as native Codex success                                            |
| Persist identity, devices, grants and capability key             | Implemented                             | Existing owner-only auth state format retained                                                                 |
| Persist pending consent requests/codes                           | Deferred                                | Short-lived authorization workflow state remains process-local                                                 |
| Multiple users/hosts/agents or simultaneous tasks in one session | Explicit non-goal                       | Independent app sessions may run concurrently on the selected runtime                                          |

The built-in OpenClaw loop projects client outputs as user text after a
synthetic delegated result. Native tool-role equivalence is not claimed.
Runtime selection, actual subscription authorization and meaningful
browser-result consumption remain release prerequisites. See the
[dependency investigation](research/2026-09-05-openclaw-replacement.md).

## Deployment and evidence

| Profile                                        | Status                                  | Assurance boundary                                                                       |
| ---------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| Private Tailscale Serve gateway                | Retained supported trust profile        | Loopback gateway checks Serve-injected allowlisted identity; enrollment pins gateway key |
| OpenClaw with deterministic inference          | Executable replacement validation setup | Real pinned dependency; fixture substitutes inference only, not OpenClaw behavior        |
| Selected subscription runtime plus browser     | Pending acceptance                      | Must demonstrate real tool-result consumption, follow-up and bounded cancellation        |
| Historical Omnigent/Codex private deployment   | Historical proven baseline              | Still running separately; not evidence for the replacement runtime                       |
| Localhost development                          | Implemented building block              | Local reachability does not define production enrollment or isolation                    |
| General public gateway, custom relay or tunnel | Deferred                                | Requires explicit identity, authorization and exposure decisions                         |
| Per-session managed containers                 | Historical exploration                  | No accepted replacement implementation or isolation guarantee                            |

## Security and reliability invariants

- HTTPS and hostname recognition do not establish gateway identity or host integrity.
- Transport authentication, owner enrollment, app consent and runtime confinement
  are separate layers; authorized applications remain adversarial principals.
- Applications cannot expand operator-selected routing, runtime credentials,
  model selection or host/native-tool policy through the public API.
- Tool results cannot answer gateway, OS or runtime approval requests.
- Unsupported fields, unknown tools, malformed security-relevant stream
  structures and ambiguous trusted-proxy identity fail closed.
- Upstream IDs are not capabilities. Local ownership and the latest admitted
  checkpoint govern continuation and recovery independently of the upstream cache.
- Durable recording precedes tool publication; ambiguous output acceptance is
  never automatically retried. No automatic transcript reconstruction is promised.
- Local cancellation and actual inference termination are distinct claims.

## Validation surfaces

Default verification exercises the pinned real OpenClaw dependency with
deterministic inference, alongside formatting, type checks, behavior tests,
policy checks and builds. Full verification additionally covers gateway
process crashes, a clean installed SDK consumer and browser tests. Exact
commands and prerequisites are maintained in the
[testing strategy](architecture/testing-strategy.md).

Historical real-Omnigent/ACP tests and earlier Codex browser traces are baseline
history, not the replacement compatibility oracle. Fresh real OpenClaw,
installed-SDK and selected subscription/browser evidence must satisfy all
four replacement contracts before cutover. Runtime posture claims must
distinguish configured, provider-reported, observed and externally attested
evidence; gateway tests do not reimplement Tailscale/WireGuard.
