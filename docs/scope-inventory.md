# Scope and capability inventory

Updated: 2026-07-20

This inventory separates implemented behavior from explicit targets. The
mission defines the product boundary; this file prevents future plans from
silently treating a target as a shipped guarantee.

## Application and SDK

| Capability                                             | Status                          | Current evidence or boundary                                                                           |
| ------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Define typed application-owned tools                   | Implemented                     | Browser-safe `defineTool`; schemas are fixed for the logical session                                   |
| Connect with an opaque application session             | Implemented                     | Browser APIs never expose OmniGENT session IDs                                                         |
| Verify a selected connector before disclosure          | Implemented                     | Runtime card pins an Ed25519 key; SDK verifies a fresh signed challenge                                |
| Authorize an HTTPS application without terminal access | Implemented                     | Connector-owned consent and S256 PKCE grant bind Origin, redirect, app id, scopes, and canonical tools |
| Dynamically enroll a previously unknown app Origin     | Implemented for Tailscale Serve | The Origin may begin authorization but receives no operational access before approval                  |
| Stream task, text, lifecycle, and tool events          | Implemented                     | Provider-neutral `AgentTaskEvent` surface                                                              |
| Execute and return a correlated browser tool result    | Implemented                     | Unknown tools and malformed arguments fail closed                                                      |
| Revoke an application's grant                          | Implemented                     | Self-revocation and connector-owned grant management invalidate later use                              |
| Install the SDK from a clean package artifact          | Implemented from source         | `npm run test:package:web`; package is not published to npm                                            |
| Recover an unresolved tool request after disconnect    | Deferred                        | No durable pending-action broker yet                                                                   |
| Provide generic exactly-once side effects              | Explicit non-goal               | Stable action IDs plus app-owned idempotency/deduplication are required                                |
| Sender-bind grants with app-instance proof/DPoP        | Deferred                        | Current grants are scoped bearer capabilities                                                          |
| Speak AG-UI between browser and gateway                | Exploration                     | See the compatibility spike; not part of the current public API                                        |
| Speak browser ACP/MCP-over-ACP                         | Experimental                    | Draft helpers remain isolated and are not the default transport                                        |

## Gateway and provider

| Capability                                                                   | Status                        | Current evidence or boundary                                                                  |
| ---------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| Broker the OmniGENT HTTP/SSE Sessions API                                    | Implemented                   | First provider behind an internal adapter                                                     |
| Provision one downstream runner and heal an unhealthy match                  | Implemented                   | Grant-bound tool policy is written before launch                                              |
| Restrict Codex's request-scoped relay tools to the authorized snapshot       | Implemented reference profile | Fail-closed manifest and `enabled_tools` compatibility wrapper, pinned to OmniGENT 0.5.1      |
| Keep provider IDs and wire types out of the normal browser API               | Implemented                   | `connectAgent` is the supported neutral entry point; legacy spike exports remain transitional |
| Allocate a fresh workspace for each provider session                         | Implemented                   | Failed launches are cleaned immediately; successful-session expiry remains deferred           |
| Persist connector identity, devices, grants, revocations, and capability key | Implemented                   | Owner-only connector state file                                                               |
| Persist pending authorization requests, codes, and provider mappings         | Deferred                      | These short-lived/session mappings are memory-only                                            |
| Persist unresolved application actions                                       | Deferred                      | A disconnect can lose an in-flight app-tool request                                           |
| Enforce a hardened real-agent sandbox                                        | Not implemented               | The source profile runs Codex as the connector's Unix user; runtime posture is operator-owned |
| Support multiple users, hosts, agents, or concurrent tasks per session       | Explicit non-goal for MVP     | One online host, one downstream agent, one active task per app session                        |

## Deployment profiles

| Profile                              | Status                            | Assurance boundary                                                                                                                  |
| ------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Private Tailscale Serve + real Codex | Implemented and manually proven   | Loopback gateway trusts Serve-injected allowlisted user identity; runtime card pins connector key; not a hostile-app sandbox        |
| Public Funnel judge appliance        | Implemented and externally proven | Fixed app/tool authority, enrolled device, deterministic ACP agent, no model credential or general shell, hardened single container |
| Localhost development                | Implemented building block        | Reachability is local; production enrollment UX is not defined                                                                      |
| General connector appliance          | Planned                           | Packaging convenience must not be described as process, credential, or tenant isolation                                             |
| Per-session container/managed runner | Exploration                       | Potential stronger runtime boundary; no accepted implementation                                                                     |
| Custom URL, relay, or other tunnel   | Deferred                          | Must define destination identity, caller identity, enrollment, and assurance rather than inheriting Tailscale claims                |

## Security and reliability invariants

- HTTPS is necessary but the URL alone is not connector identity.
- The runtime card authenticates connector-key continuity; it does not attest
  to host integrity or benign software.
- Transport authentication, connector enrollment, browser-device enrollment,
  application authorization, and runtime confinement are separate layers.
- Authorization grants capability to an app; it does not make the app
  trustworthy.
- An application cannot expand the connector-selected Codex mode, native-tool
  policy, filesystem, network, credential, or approval authority through the
  Agent Connect protocol.
- Application tool results cannot answer connector, OS, harness, or native-tool
  approval requests.
- Unknown provider events, unknown tools, malformed inputs, policy-manifest
  drift, and ambiguous trusted-proxy identities fail closed.
- The public judge appliance is a reproducible protocol/application proof, not
  evidence that the private real-Codex runtime is sandboxed.
- Stable action IDs support app-owned idempotency; unresolved-action durability
  is still pending.

## Validation surfaces

1. `npm run verify` covers formatting, type checks, behavior tests, policy
   checks, and builds.
2. `npm run verify:full` additionally packs/installs the SDK in a clean
   consumer and runs Canvas browser tests.
3. `npm run test:integration:omnigent` starts disposable real OmniGENT services
   and a deterministic ACP/MCP agent without model credentials.
4. The real Tailscale Serve + OmniGENT + Codex + deployed-browser flow is a
   manual composition milestone.
5. The public Funnel profile is tested from a clean external browser and has a
   documented reboot and teardown path.

Connector tests validate how Agent Connect consumes trusted-proxy identity;
they do not attempt to reimplement or prove Tailscale/WireGuard. Runtime posture
claims must identify whether evidence is configured, provider-reported,
observed, or externally attested.
