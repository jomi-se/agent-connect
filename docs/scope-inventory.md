# Scope and capability inventory

Updated: 2026-08-29

This inventory separates implemented behavior from explicit targets. The
mission defines the product boundary; this file prevents future plans from
silently treating a target as a shipped guarantee.

## Application and SDK

| Capability                                             | Status                          | Current evidence or boundary                                                                         |
| ------------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Define typed application-owned tools                   | Implemented                     | Browser-safe `defineTool`; schemas are fixed for the logical session                                 |
| Connect with an opaque application session             | Implemented                     | Browser APIs never expose Omnigent session IDs                                                       |
| Verify a selected gateway before disclosure            | Implemented                     | Runtime card pins an Ed25519 key; SDK verifies a fresh signed challenge                              |
| Authorize an HTTPS application without terminal access | Implemented                     | Gateway-owned consent and S256 PKCE grant bind Origin, redirect, app id, scopes, and canonical tools |
| Dynamically enroll a previously unknown app Origin     | Implemented for Tailscale Serve | The Origin may begin authorization but receives no operational access before approval                |
| Stream task, text, lifecycle, and tool events          | Implemented                     | Provider-neutral `AgentTaskEvent` surface                                                            |
| Execute and return a correlated browser tool result    | Implemented                     | Unknown tools and malformed arguments fail closed                                                    |
| Revoke an application's grant                          | Implemented                     | Self-revocation and gateway-owned grant management invalidate later use                              |
| Install the SDK from a clean package artifact          | Implemented from source         | `npm run test:package:web`; package is not published to npm                                          |
| Recover an unresolved tool request after disconnect    | Deferred                        | No durable pending-action broker yet                                                                 |
| Provide generic exactly-once side effects              | Explicit non-goal               | Stable action IDs plus app-owned idempotency/deduplication are required                              |
| Sender-bind grants with app-instance proof/DPoP        | Deferred                        | Current grants are scoped bearer capabilities                                                        |
| Speak Open Responses between application and gateway   | Implemented                     | Bounded v0 profile; standard client, real Omnigent, crash, and real-Codex browser evidence           |
| Speak AG-UI between browser and gateway                | Deprioritized exploration       | Optional edge adapter only unless Open Responses cannot meet a concrete UI requirement               |
| Speak browser ACP/MCP-over-ACP                         | Experimental                    | Draft helpers remain isolated and are not the default transport                                      |

## Gateway and provider

| Capability                                                                 | Status                        | Current evidence or boundary                                                                |
| -------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| Broker the Omnigent HTTP/SSE Sessions API                                  | Implemented                   | First provider behind an internal adapter                                                   |
| Provision one downstream runner and heal an unhealthy match                | Implemented                   | Grant-bound tool policy is written before launch                                            |
| Restrict Codex's request-scoped relay tools to the authorized snapshot     | Implemented reference profile | Fail-closed manifest and `enabled_tools` compatibility wrapper, pinned to Omnigent 0.5.1    |
| Keep provider IDs and wire types out of the normal browser API             | Implemented                   | `connectAgent` is neutral; browser-visible Omnigent exports and routes are removed          |
| Expose an OAuth-protected Open Responses endpoint                          | Implemented                   | Bounded `POST /v1/responses` plus explicit Agent Connect recovery and cancellation controls |
| Bundle response translation with harness runtime supervision               | Implemented for Omnigent      | Response engine and bundled backend share one gateway process; no private facade protocol   |
| Allocate a fresh workspace for each provider session                       | Implemented                   | Failed launches are cleaned immediately; successful-session expiry remains deferred         |
| Persist gateway identity, devices, grants, revocations, and capability key | Implemented                   | Owner-only gateway state file                                                               |
| Persist pending authorization requests, codes, and provider mappings       | Deferred                      | These short-lived/session mappings are memory-only                                          |
| Persist unresolved application actions                                     | Deferred                      | A disconnect can lose an in-flight app-tool request                                         |
| Enforce a hardened real-agent sandbox                                      | Not implemented               | The source profile runs Codex as the gateway's Unix user; runtime posture is operator-owned |
| Support multiple users, hosts, agents, or concurrent tasks per session     | Explicit non-goal for MVP     | One online host, one downstream agent, one active task per app session                      |

## Deployment profiles

| Profile                              | Status                          | Assurance boundary                                                                                                         |
| ------------------------------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Private Tailscale Serve + real Codex | Implemented and manually proven | Loopback gateway trusts Serve-injected allowlisted user identity; runtime card pins gateway key; not a hostile-app sandbox |
| Localhost development                | Implemented building block      | Reachability is local; production enrollment UX is not defined                                                             |
| General gateway deployment           | Planned                         | Packaging convenience must not be described as process, credential, or tenant isolation                                    |
| Per-session container/managed runner | Exploration                     | Potential stronger runtime boundary; no accepted implementation                                                            |
| Custom URL, relay, or other tunnel   | Deferred                        | Must define destination identity, caller identity, enrollment, and assurance rather than inheriting Tailscale claims       |

## Security and reliability invariants

- HTTPS is necessary but the URL alone is not gateway identity.
- The runtime card authenticates gateway-key continuity; it does not attest
  to host integrity or benign software.
- Transport authentication, gateway enrollment, browser-device enrollment,
  application authorization, and runtime confinement are separate layers.
- Authorization grants capability to an app; it does not make the app
  trustworthy.
- An application cannot expand the gateway-selected Codex mode, native-tool
  policy, filesystem, network, credential, or approval authority through the
  Agent Connect protocol.
- Application tool results cannot answer gateway, OS, harness, or native-tool
  approval requests.
- Unknown provider events, unknown tools, malformed inputs, policy-manifest
  drift, and ambiguous trusted-proxy identities fail closed.
- Stable action IDs support app-owned idempotency; unresolved-action durability
  is still pending.

## Validation surfaces

1. `npm run verify` covers formatting, type checks, behavior tests, policy
   checks, builds, and the deterministic real-Omnigent compatibility suite.
2. `npm run verify:full` additionally kills and restarts real gateway
   subprocesses at durability boundaries, packs/installs the SDK in a clean
   consumer, and runs Canvas browser tests.
3. `npm run test:integration:omnigent` runs that provider gate directly,
   starting disposable real Omnigent services and a deterministic ACP/MCP agent
   without model credentials.
4. The real Tailscale Serve + Omnigent + Codex + deployed-browser flow is a
   manual composition milestone.

Gateway tests validate how Agent Connect consumes trusted-proxy identity;
they do not attempt to reimplement or prove Tailscale/WireGuard. Runtime posture
claims must identify whether evidence is configured, provider-reported,
observed, or externally attested.
