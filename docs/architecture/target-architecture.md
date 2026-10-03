# Current architecture and acceptance boundary

The owner-approved current implementation is the standalone ACP gateway under
[proposed ADR 0016](../decisions/0016-acp-application-boundary.md). Formal ADR
acceptance and publication remain owner gates. The implementation comprises the ACP gateway and root browser SDK.

## Current ACP boundary

```text
application / browser
  @open-agent-connect/web + application-owned functions
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

## Ownership boundaries

The application owns its functions, UI and effects. Stable action IDs require
application-owned idempotency or deduplication. Lost acknowledgements do not
prove whether an effect ran.

The gateway owns owner authentication, exact-origin fixed-tool consent, rotating
grants, permission profiles, session admission, action journaling and owned box
cleanup. The harness owns inference, native execution and its own history.
Browser chat uses `createAcpChatTransport` with AI SDK `useChat`; the SDK executes
approved tools internally and never starts a second model loop.

Resume delivery and conversation recovery are separate. Sequence reattachment
can continue an active stream. An ended session requires explicit history load;
uncertain prompts and application actions are never automatically resent.
