# Scope and capability inventory

## Application-facing web SDK

| Capability                                          | Current milestone | Observable evidence                                                               |
| --------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------- |
| Create an opaque application session                | Session slice     | Browser receives no OmniGENT id                                                   |
| Pair user presence through a private channel        | Session slice     | One-time terminal code exchanges for a scoped capability                          |
| Reach a user-owned runtime from an HTTPS web app    | Remote slice      | Tailnet-only HTTPS gateway enforces Origin and Tailscale identity                 |
| Verify continuity with an enrolled runtime          | Identity slice    | Connector proves possession of the key bound during first-use enrollment          |
| Report transport/runtime assurance                  | Identity slice    | SDK distinguishes Tailscale transport, connector-key proof, and unverified claims |
| Mutate visible state from a dynamically lent tool   | Remote demo       | Firebase Canvas exposes one bounded in-memory page-write tool                     |
| Supply a fixed request-scoped tool snapshot         | Browser slice     | First message event carries OpenAI-format dynamic tool schemas                    |
| Stream normalized task progress                     | Browser slice     | Text, lifecycle, and tool events are observable incrementally                     |
| Execute a typed application tool handler            | Browser slice     | `action_required` invokes the registered handler exactly once                     |
| Return a correlated result                          | Browser slice     | `function_call_output` preserves the OmniGENT `call_id`                           |
| Reject malformed/unknown tool calls and HTTP errors | Browser slice     | Unit tests observe stable public errors                                           |
| Cancel an active task                               | Browser slice     | Client posts an interrupt event                                                   |
| Connect to ACP over browser WebSocket               | Experimental      | Existing transport helper remains isolated                                        |
| Register one application-owned MCP server           | Experimental      | Existing narrow MCP-over-ACP handler remains isolated                             |
| Stream ACP session updates                          | Conductor spike   | Browser receives Codex text/tool progress                                         |
| Surface permission requests                         | Demo slice        | Browser renders and resolves mutation approval                                    |
| Reconnect and load an agent session                 | Reliability slice | New transport loads the stored session ID                                         |
| Recover unresolved application action               | Reliability slice | Pending action is listed or redispatched after reconnect                          |
| Prevent duplicate demonstrated spreadsheet mutation | Reliability slice | Stable action ID and spreadsheet deduplication produce one write                  |

## Conductor and OmniGENT provider

| Capability                                        | Current milestone | Main risk                                                   |
| ------------------------------------------------- | ----------------- | ----------------------------------------------------------- |
| Use existing OmniGENT HTTP/SSE session transport  | Browser slice     | Browser CORS/auth deployment still needs real-surface proof |
| Pass request-scoped tools into the first turn     | Proven spike      | Live nonce composition passed on 2026-07-13                 |
| Drive maintained `@agentclientprotocol/codex-acp` | Proven spike      | Live Codex turn completed with published adapter 1.1.2      |
| Round-trip `action_required` tool output          | Proven spike      | Exact-once callback and same-turn completion observed       |
| Provision and bind runners                        | Session slice     | Gateway uploads the fixed agent bundle and selects one host |
| Reuse a healthy matching session                  | Session slice     | Same origin/app/tool hash resolves to one logical session   |
| Heal an offline matching runner                   | Session slice     | Gateway transparently provisions a replacement runner       |
| Persist pending application actions               | Reliability slice | OmniGENT currently does not persist `action_required` calls |

## Security and reliability constraints

- Application tools are explicit, typed, session-scoped, auditable, and revocable.
- The deployed gateway listens on loopback behind Tailscale Serve HTTPS.
- Browser origins and Tailscale logins are exact allowlists; CORS is not user authentication.
- A `.ts.net` hostname is not identity evidence by itself. The Tailscale profile
  requires private Serve posture, loopback isolation, requester identity, and a
  user-approved binding to the connector key.
- Mutating tools require visible approval or a preview policy.
- The conductor authenticates and pairs applications; raw Codex app-server is never internet-exposed.
- A pairing code is single-use and is delivered only through the connector's
  local terminal. It is never compiled into a hosted application.
- Application capabilities are signed, expiring, and bound to origin, app id,
  logical session id, and canonical tool-snapshot hash.
- Prompt ingress is an execution capability: an authenticated application may
  instruct the agent, but it cannot raise the agent's local sandbox or approval
  policy through Agent Connect.
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
