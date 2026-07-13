# Scope and capability inventory

## Application-facing web SDK

| Capability                                          | Current milestone | Observable evidence                                               |
| --------------------------------------------------- | ----------------- | ----------------------------------------------------------------- |
| Bind to an existing OmniGENT session                | Browser slice     | Browser-safe client uses only fetch/SSE-compatible primitives     |
| Reach a user-owned runtime from an HTTPS web app    | Remote slice      | Tailnet-only HTTPS gateway enforces Origin and Tailscale identity |
| Mutate visible state from a dynamically lent tool   | Remote demo       | Firebase Canvas exposes one bounded in-memory page-write tool     |
| Supply a fixed request-scoped tool snapshot         | Browser slice     | First message event carries OpenAI-format dynamic tool schemas    |
| Stream normalized task progress                     | Browser slice     | Text, lifecycle, and tool events are observable incrementally     |
| Execute a typed application tool handler            | Browser slice     | `action_required` invokes the registered handler exactly once     |
| Return a correlated result                          | Browser slice     | `function_call_output` preserves the OmniGENT `call_id`           |
| Reject malformed/unknown tool calls and HTTP errors | Browser slice     | Unit tests observe stable public errors                           |
| Cancel an active task                               | Browser slice     | Client posts an interrupt event                                   |
| Connect to ACP over browser WebSocket               | Experimental      | Existing transport helper remains isolated                        |
| Register one application-owned MCP server           | Experimental      | Existing narrow MCP-over-ACP handler remains isolated             |
| Stream ACP session updates                          | Conductor spike   | Browser receives Codex text/tool progress                         |
| Surface permission requests                         | Demo slice        | Browser renders and resolves mutation approval                    |
| Reconnect and load an agent session                 | Reliability slice | New transport loads the stored session ID                         |
| Recover unresolved application action               | Reliability slice | Pending action is listed or redispatched after reconnect          |
| Prevent duplicate demonstrated spreadsheet mutation | Reliability slice | Stable action ID and spreadsheet deduplication produce one write  |

## Conductor and OmniGENT provider

| Capability                                        | Current milestone | Main risk                                                   |
| ------------------------------------------------- | ----------------- | ----------------------------------------------------------- |
| Use existing OmniGENT HTTP/SSE session transport  | Browser slice     | Browser CORS/auth deployment still needs real-surface proof |
| Pass request-scoped tools into the first turn     | Proven spike      | Live nonce composition passed on 2026-07-13                 |
| Drive maintained `@agentclientprotocol/codex-acp` | Proven spike      | Live Codex turn completed with published adapter 1.1.2      |
| Round-trip `action_required` tool output          | Proven spike      | Exact-once callback and same-turn completion observed       |
| Provision and bind runners                        | Deferred          | First client binds an already-created, online session       |
| Persist pending application actions               | Reliability slice | OmniGENT currently does not persist `action_required` calls |

## Security and reliability constraints

- Application tools are explicit, typed, session-scoped, auditable, and revocable.
- The deployed gateway listens on loopback behind Tailscale Serve HTTPS.
- Browser origins and Tailscale logins are exact allowlists; CORS is not user authentication.
- Mutating tools require visible approval or a preview policy.
- The conductor authenticates and pairs applications; raw Codex app-server is never internet-exposed.
- Stable action IDs are preserved across retries and reconnects.
- The demo application's mutation endpoint is idempotent by action ID.
- Loss of token deltas is acceptable; loss of an unresolved mutation request is not.

## Validation readiness

- Library surface: public TypeScript imports and direct handler calls under Vitest.
- Browser surface: a real browser against the demo and gateway, including disconnect/reconnect.
- Protocol surface: captured OmniGENT session HTTP/SSE and tool-result traces.
- Persistence surface: database state before request, while pending, and after completion.
- Downstream surface: a live Codex turn authenticated with the user's existing Codex login.

The live Codex composition environment is established. A real browser against
the browser client is the next validation gate.
