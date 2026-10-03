# Current architecture and acceptance boundary

The owner-approved current implementation is the standalone ACP gateway under
[proposed ADR 0016](../decisions/0016-acp-application-boundary.md). Formal ADR
acceptance and publication remain owner gates. The previous published OpenClaw
plugin selected by ADR 0015 remains available and tested.

## Current ACP boundary

```text
application / browser
  @open-agent-connect/web/acp + application-owned functions
                 | owner-hosted consent + S256 PKCE
                 | exact-origin rotating grants + ACP WebSocket (unstable)
                 v
Agent Connect gateway
  owner sign-in / optional TOTP / consent / grant revocation
  fixed approved tools / policy proxy / resumable session hosts
                 | official ACP adapter + MCP-over-ACP polyfill (unstable)
                 v
one disposable Docker box per session
  dedicated shared harness home + restricted owned egress
  provider harness owns inference and native execution
```

Owner authority, config and grant state remain outside the harness mount.
Application tokens cannot approve new grants. Capacity defaults to one box until
provider credential-refresh concurrency is qualified. ACP permission profiles
control requests the harness actually emits; the box bounds native execution.
Revocation ends active and detached authority; recovery never automatically
replays uncertain prompts or application effects. Transport frame limits,
retention and operator controls are documented in the
[configuration guide](../install/configuration.md).

## Previous plugin component map

```text
application / browser
  @open-agent-connect/web + application-owned functions
                 |
                 | OAuth/PKCE + bounded Open Responses
                 v
OpenClaw gateway
  Agent Connect plugin under /agent-connect
  owner login, consent, grants, fixed tool snapshot
  process-local conversation authority
                 |
                 | internal native Responses request
                 v
operator-selected OpenClaw agent/runtime/model
```

The application never receives an OpenClaw operator credential, native agent
identifier, or private session key. The plugin constructs those values from
owner-reviewed configuration and admits only the bounded application request
profile.

## Ownership boundaries

The application owns its functions and external side effects. Consequential
operations need stable call IDs plus application-owned idempotency or
deduplication; loss of an acknowledgement does not prove whether an effect ran.

The plugin owns OAuth/PAR/S256 PKCE, explicit owner consent, rotating access,
refresh and revocation credentials, the exact approved tool snapshot, request
construction, response inspection, and the bounded mapping between application
grants and active OpenClaw conversations. That mapping is intentionally
process-local: restart, expiry, revocation, policy change, failed streams, and
ambiguous disconnects end continuation without replay.

OpenClaw owns execution, native history, compaction, native tools, sandboxing,
model selection, provider credentials, and its gateway lifecycle. Agent Connect
uses the public OpenClaw plugin and native Responses seams; it does not patch
OpenClaw core or replace its agent loop.

## Security boundary

The plugin is namespaced under `/agent-connect` and cannot be used to select an
arbitrary native agent, model, session, URL, header, or host tool. Setup creates
one owner-reviewed restricted application agent. Unsupported inherited tools,
skills, memory, context injection, elevation, or other policy drift fail closed.

Applications receive only their grant-scoped recent execution projection.
Native user entries may represent prompts or application outputs, so this is not
presented as a faithful human-chat transcript.

## Evidence and limits

Credential-free tests install the exact packed plugin into the pinned OpenClaw package
and exercise setup/doctor, discovery, owner login, OAuth, bounded application
tools, continuation, history, refresh/revoke, lifecycle disable/re-enable,
configuration refusal, and coexistence with a native owner request. Inference is
deterministic; these tests do not spend subscription allowance.

Selected subscription/browser behavior remains separate owner evidence. The
system does not claim arbitrary host-plugin safety, restart recovery, generic
exactly-once execution, production multi-tenancy, or a finalized universal
protocol.
