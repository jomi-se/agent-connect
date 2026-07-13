# Scope and capability inventory

## Application-facing web SDK

| Capability                                          | Current milestone | Observable evidence                                                 |
| --------------------------------------------------- | ----------------- | ------------------------------------------------------------------- |
| Connect to ACP over browser WebSocket               | Foundation        | Browser establishes and initializes a connection                    |
| Register one application-owned MCP server           | Foundation        | `session/new` carries one ACP MCP descriptor                        |
| Discover fixed session tools                        | Foundation        | MCP `initialize` and `tools/list` return declared schemas           |
| Execute a typed tool handler                        | Foundation        | MCP `tools/call` invokes the registered handler and returns content |
| Reject unknown server, connection, method, or tool  | Foundation        | Unit tests observe stable protocol errors                           |
| Stream ACP session updates                          | Conductor spike   | Browser receives Codex text/tool progress                           |
| Surface permission requests                         | Demo slice        | Browser renders and resolves mutation approval                      |
| Reconnect and load an agent session                 | Reliability slice | New transport loads the stored session ID                           |
| Recover unresolved application action               | Reliability slice | Pending action is listed or redispatched after reconnect            |
| Prevent duplicate demonstrated spreadsheet mutation | Reliability slice | Stable action ID and spreadsheet deduplication produce one write    |

## Conductor and OmniGENT fork

| Capability                                         | Current milestone | Main risk                                                   |
| -------------------------------------------------- | ----------------- | ----------------------------------------------------------- |
| Accept upstream ACP over WebSocket                 | Conductor spike   | Transport and authentication are not stable ACP baseline    |
| Map ACP session lifecycle to OmniGENT Sessions API | Conductor spike   | Semantic mismatch and cancellation cleanup                  |
| Translate OmniGENT SSE into ACP session updates    | Conductor spike   | Live-tail gaps and event normalization                      |
| Terminate one MCP-over-ACP server                  | Conductor spike   | Draft protocol drift                                        |
| Pass discovered tools into first OmniGENT turn     | Composition spike | Generic ACP relay caches its initial tool set               |
| Drive maintained `@agentclientprotocol/codex-acp`  | Composition spike | Authentication and exact callback path need live proof      |
| Round-trip `action_required` tool output           | Composition spike | Exact composition is inferred, not yet proven live          |
| Persist pending application actions                | Reliability slice | OmniGENT currently does not persist `action_required` calls |

## Security and reliability constraints

- Application tools are explicit, typed, session-scoped, auditable, and revocable.
- Mutating tools require visible approval or a preview policy.
- The conductor authenticates and pairs applications; raw Codex app-server is never internet-exposed.
- Stable action IDs are preserved across retries and reconnects.
- The demo application's mutation endpoint is idempotent by action ID.
- Loss of token deltas is acceptable; loss of an unresolved mutation request is not.

## Validation readiness

- Library surface: public TypeScript imports and direct handler calls under Vitest.
- Browser surface: a real browser against the demo and gateway, including disconnect/reconnect.
- Protocol surface: captured ACP and nested MCP request/response traces.
- Persistence surface: database state before request, while pending, and after completion.
- Downstream surface: a live Codex turn authenticated with the user's existing Codex login.

The live Codex and browser validation environments are not established yet. The composition spike is the gate before expanding the implementation.
