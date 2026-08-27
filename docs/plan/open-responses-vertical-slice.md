# Open Responses vertical-slice implementation plan

Updated: 2026-08-27

## Outcome

Prove that the existing Agent Connect gateway can present one useful, honest
subset of Open Responses in front of the already working Omnigent -> Codex
runtime. The proof must complete a real multi-step application-function loop;
it is not a route-renaming exercise.

This plan deliberately leaves the existing authorization ceremony, gateway
session provisioning, Omnigent supervision, and fixed approved tool snapshot
in place. Broad route-framework work, generalized harness abstractions, OAuth
replacement, WebMCP, and a second backend wait until this slice is proven.

The implementation has two decision gates:

1. **Protocol-fit gate:** a standard Responses client can create and continue
   responses through multiple sequential application function calls while the
   same Omnigent/Codex execution remains alive.
2. **Replacement gate:** the response and pending-call state is durable,
   cancellation/recovery behavior is explicit, the browser SDK uses the new
   path, and the old public task/event wire can be deleted.

[ADR 0010](../decisions/0010-open-responses-gateway-pivot.md) remains proposed
until the replacement gate passes.

## Investigation baseline

### What already works

- `packages/gateway/src/gateway.ts` authenticates the browser Origin, checks a
  revocable application grant, creates an opaque application session, and
  issues a short-lived session capability.
- The application session is already bound to the canonical hash of the exact
  approved function definitions. A different snapshot cannot reuse it.
- `packages/gateway/src/omnigent-runtime.ts` provisions one Omnigent session
  and writes the approved application function names into its private policy.
- `packages/web-sdk/src/omnigent-provider.ts` opens one Omnigent SSE stream,
  posts a prompt and function definitions, submits correlated function
  outputs, and leaves the underlying Codex turn alive across multiple calls.
- `packages/web-sdk/src/agent-session.ts` validates arguments, executes the
  application-owned handler, serializes its output, and suppresses a repeated
  action ID within one in-memory task.
- `packages/gateway/test/omnigent-real.integration.test.ts` is the behavioral
  oracle: disposable real Omnigent services plus a deterministic ACP agent
  already prove the multi-call application-function loop without consuming a
  model credential.

### Gaps that matter to the slice

- The gateway currently proxies Omnigent bytes on
  `/v1/sessions/:id/stream` and `/events`; it does not own Responses state or
  standard event ordering.
- The Omnigent stream is tied to the browser HTTP request. A premature browser
  close aborts the upstream stream.
- Open Responses completes one response segment when it yields an external
  function call. Omnigent instead keeps one downstream stream open while it
  waits for the function output. The gateway must bridge these two lifecycles.
- Application sessions retain approved function names and a hash, but the
  response profile validator also needs the canonical approved definitions.
- Provider-session mappings, response chains, and unresolved function calls
  are memory-only. There is no persistence-before-publication guarantee yet.
- Current public SDK events are a custom task vocabulary. They should remain
  only as a convenience layer during migration, not as a second gateway wire.

## Standards baseline

The profile is pinned for implementation and tests to:

- Open Responses OpenAPI version `2.3.0`;
- upstream repository commit
  `92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c` (2026-07-15); and
- the specification, reference, and compliance suite available on 2026-08-27.

The standard currently defines `POST /responses` and
`POST /responses/compact`. It defines `previous_response_id`, external
function calls and outputs, response resources, semantic SSE events, event
ordering, monotonically increasing `sequence_number`, and a terminal
`data: [DONE]` frame. It does **not** currently define general HTTP retrieval,
pending-call recovery, or cancellation endpoints. Agent Connect must label its
additional control operations as Agent Connect extensions.

Do not copy the complete upstream request type into the gateway. Keep a pinned
OpenAPI fixture or reduced generated validation fixture for tests, then expose
only the profile below in production code.

## Version 0 profile

### Transport and authorization

- Endpoint: `POST /v1/responses`.
- Authentication: the existing short-lived application-session capability in
  `Authorization: Bearer ...`.
- Browser requests still require the exact Origin bound into that capability.
- The existing `/v1/app-sessions` authorization and provisioning step remains
  the control plane that produces the capability. It is not part of Open
  Responses conformance.
- Support both JSON (`stream: false` or omitted) and SSE (`stream: true`) from
  the same response engine. Buffering the same event/result model for the
  non-streaming case is small and makes ordinary client compatibility much
  more useful.

### Accepted initial request

| Field                  | Version 0 behavior                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `model`                | Required and exactly `agent-connect/default`                                        |
| `input`                | Non-empty string, or one `user` message containing text                             |
| `tools`                | Function tools only; canonical definitions must exactly match the approved snapshot |
| `tool_choice`          | Omitted, `null`, or `auto`                                                          |
| `parallel_tool_calls`  | Omitted, `null`, or `false`                                                         |
| `stream`               | Omitted/false for JSON, true for SSE                                                |
| `store`                | Omitted or true                                                                     |
| `previous_response_id` | Omitted or null                                                                     |

The gateway normalizes accepted tools once, checks their canonical hash, and
stores their complete definitions on the logical run. The application cannot
change the snapshot after the run begins.

### Accepted continuation request

- `model` remains exactly `agent-connect/default`.
- `previous_response_id` identifies the immediately preceding response in the
  same authorized application session and chain.
- `input` contains exactly one string-valued `function_call_output` for the
  one unresolved sequential call.
- `call_id` must match that unresolved call.
- `tools` may be omitted or repeat the exact approved snapshot. A mutation is
  an authorization error, not a new tool configuration.
- `stream`, `store`, `tool_choice`, and `parallel_tool_calls` have the same
  restrictions as the initial request.

A later version may accept a new user message on an existing chain. It is not
needed to prove the remote application-function loop.

### Explicitly rejected

Reject unknown fields and unsupported non-default combinations with a stable
4xx error; never silently discard them. Version 0 rejects:

- assistant, developer, system, image, file, audio, or arbitrary item input;
- `instructions`, conversations, compaction, or truncation configuration;
- `store: false`, background mode, and WebSocket transport;
- parallel calls or multiple function outputs in one continuation;
- hosted, MCP, shell, computer, custom, or other non-function tools;
- forced/specific tool choice;
- response formatting, sampling, reasoning, token-budget, service-tier,
  metadata, include, cache, safety, and provider-extension fields; and
- any model other than `agent-connect/default`.

This strictness is intentional. We can add a field when a real application
needs it and the backend has a testable meaning for it.

### Public response and stream

Use standard response, message, output-text, function-call, and error shapes.
Do not emit Omnigent `action_required`, provider session IDs, ACP events, or
Agent Connect task events on this endpoint.

For a text item, emit the standard lifecycle:

```text
response.created
response.in_progress
response.output_item.added
response.content_part.added
response.output_text.delta *
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
data: [DONE]
```

For a function item, emit:

```text
response.output_item.added
response.function_call_arguments.done
response.output_item.done
response.completed
data: [DONE]
```

Every SSE frame has an `event:` value equal to the JSON `type`, and every JSON
event has an increasing `sequence_number`. A completed segment may contain
text followed by one function call. The function-call item uses a
gateway-generated opaque `call_id`; the provider's request token remains
internal.

`response.completed` means that response segment is complete. The SDK decides
that the higher-level run is complete only when the completed response has no
unresolved application function call.

Use the standard error envelope (`error.type`, `error.code`, `error.param`,
and `error.message`). Pin these version 0 codes rather than forwarding provider
messages as API behavior:

| Code                          | Typical status | Meaning                                                       |
| ----------------------------- | -------------- | ------------------------------------------------------------- |
| `invalid_request`             | 400            | malformed supported-profile input                             |
| `unsupported_feature`         | 400            | known Open Responses field or combination outside version 0   |
| `model_not_found`             | 400            | model is not `agent-connect/default`                          |
| `previous_response_not_found` | 404            | response is absent, expired, unauthorized, or not continuable |
| `tool_snapshot_mismatch`      | 403            | function definitions differ from the approved snapshot        |
| `function_call_not_found`     | 409            | output does not match the one unresolved sequential call      |
| `function_output_conflict`    | 409            | the call already has a different recorded output              |
| `response_busy`               | 409            | another operation is active on the chain                      |
| `response_cancelled`          | 409            | the chain was cancelled and cannot continue                   |
| `backend_unavailable`         | 502            | the selected user-owned runtime cannot be reached             |
| `backend_protocol_error`      | 502            | the backend violated the narrow translation contract          |

Authentication keeps the existing gateway error codes and HTTP semantics.
Once streaming has begun, emit a standard `error` event followed by
`response.failed` and `[DONE]`.

## Minimal internal design

Add one deep response module and one concrete Omnigent backend. Do not split
them into services or create a general harness framework.

```text
gateway route + existing session capability
                 |
                 v
Responses profile parser / serializer
                 |
                 v
ResponseEngine ---- ResponseStore
  chain state         response records
  event ordering      pending-call ledger
  continuation        result deduplication
  public errors       cancellation state
                 |
                 v
OmnigentResponseBackend
  owns live upstream stream and provider tokens
  translates only text, app calls, completion, and failure
                 |
                 v
existing AgentRuntime provisioning -> Omnigent -> Codex
```

Suggested source boundaries:

- `packages/gateway/src/responses/profile.ts`: validate and normalize the
  supported request profile; reject everything else.
- `packages/gateway/src/responses/protocol.ts`: the selected standard types,
  response-resource builders, and event builders.
- `packages/gateway/src/responses/engine.ts`: response-chain state machine,
  serialization of one active operation per chain, public IDs, and error
  mapping.
- `packages/gateway/src/responses/store.ts`: narrow persistence interface and
  a file-backed implementation using the gateway's existing state-directory
  conventions.
- `packages/gateway/src/responses/sse.ts`: SSE framing and disconnect handling.
- `packages/gateway/src/omnigent-response-backend.ts`: concrete ownership of
  the long-lived Omnigent stream, event translation, output submission,
  reattachment, and interruption.
- `packages/gateway/src/response-routes.ts`: small route adapter mounted from
  the existing `gateway.ts`; no general router migration.
- `packages/web-sdk/src/responses-provider.ts`: client-side continuation loop
  behind the existing `AgentProvider` seam during migration.

Keep `AgentRuntime` focused on provisioning and health until the concrete
backend proves that it needs a broader seam. Do not make every internal module
accept the full public Responses request.

### Lifecycle bridge

1. The first response request resolves its application session from the bearer
   capability and validates the full request against that session's approved
   snapshot.
2. The engine allocates a response chain and asks the concrete backend to open
   the Omnigent stream and post the initial message.
3. The backend consumes Omnigent events. Text becomes standard response events.
4. On an application function call, the engine creates its own stable
   `call_id`, stores the provider token privately, durably records the pending
   call, and only then publishes it.
5. The engine completes that Open Responses segment but deliberately retains
   the underlying backend run, which is waiting for a result.
6. A new request supplies `previous_response_id` plus the matching
   `function_call_output`. The engine records/deduplicates the result, maps the
   public call ID back to the private provider token, posts it to Omnigent, and
   resumes consuming the same logical run.
7. Steps 4-6 repeat for sequential calls. A provider completion produces the
   final response segment and closes the backend run.

An HTTP client disconnect before a segment reaches a terminal event requests
best-effort cancellation. The intentional close after a function-call segment
must **not** abort the backend run.

### Durable records

Persist only state the gateway owns:

- chain ID, application session ID, tool hash, and provider session mapping;
- each response ID, previous response ID, normalized input, output items,
  status, timestamps, and terminal error;
- each public call ID, private provider token, tool name, arguments, owning
  response, state, and optional result fingerprint; and
- cancellation/failure state.

The call transition is `pending -> delivered -> resolved`. The `pending`
record must reach durable storage before its SSE event is written. Repeating
the same output for a resolved call returns the recorded outcome; a different
output for the same call ID fails with a conflict. This is idempotent result
submission, not a claim of exactly-once application side effects.

## Implementation sequence

### Milestone 1: executable profile contract

1. Pin the upstream version/commit and derive a small, committed test fixture
   containing only the response resource and events used by version 0.
2. Implement the request parser, normalized internal command, response/event
   builders, SSE encoder, and stable error mapping.
3. Add table-driven tests for every accepted and rejected field combination.
4. Validate produced JSON resources and SSE events against the pinned schemas.

Checkpoint: deterministic unit tests prove that the gateway emits standard
shapes and fails unsupported features explicitly. No Omnigent code changes yet.

### Milestone 2: in-memory protocol-fit slice

1. Implement `ResponseEngine` with an in-memory store and a deterministic fake
   backend.
2. Prove text-only, text-then-call, call-output continuation, two sequential
   calls, final text, malformed arguments, wrong call IDs, duplicate outputs,
   provider failure, and concurrent-continuation rejection.
3. Add `POST /v1/responses` behind the existing session capability.
4. Implement the concrete Omnigent backend that owns the upstream stream
   independently of one browser request.
5. Extend the existing disposable Omnigent integration test to execute two
   calls through `previous_response_id` and verify one downstream provider
   session is retained.

Checkpoint: an ordinary Responses client completes the deterministic
multi-call scenario. This is the protocol-fit decision gate, not production
readiness; the old routes remain the default.

If Omnigent cannot safely retain or reattach the waiting stream, stop here and
test the same engine against the documented Codex app-server fallback. Do not
distort the public profile around an Omnigent limitation.

### Milestone 3: browser SDK migration

1. Implement `ResponsesProvider` using standard response requests and events.
2. Preserve the current `connectAgent()`, tool execution, and `runTask()` user
   experience while chaining response segments internally.
3. Make `connectAgent()` select the Responses provider by default; retain the
   old Omnigent provider only as an explicitly transitional test path.
4. Add browser-safe tests for streaming, cancellation, tool errors, repeated
   calls, and no Node-only imports.

Checkpoint: the Canvas application completes its existing user flow through
`/v1/responses`; no browser package imports Omnigent wire types for the new
path.

### Milestone 4: durability, recovery, and cancellation

1. Replace the in-memory store with the narrow file-backed store and atomic
   updates.
2. Restore response-chain/provider mappings on gateway restart and define what
   Omnigent can reattach versus what fails as an interrupted run.
3. Add two explicitly Agent Connect control operations, addressed by an opaque
   response ID:
   - `GET /v1/agent-connect/responses/:responseId/pending-function-calls` to
     retrieve/redeliver unresolved application function calls; and
   - `POST /v1/agent-connect/responses/:responseId/cancel` to cancel the
     logical response chain and propagate interruption downstream.
4. Check grant revocation on continuation, recovery, and cancellation.
5. Add crash-point tests immediately before and after pending-call publication
   and result acknowledgement.

Checkpoint: a disconnect or gateway restart cannot silently lose an already
published unresolved call, duplicate output submission is deterministic, and
cancellation reaches Omnigent/Codex where the backend supports it.

### Milestone 5: conformance, replacement, and deletion

1. Run the applicable upstream compliance tests: basic text, streaming, and
   function calling. Record the unsupported upstream cases as profile
   exclusions rather than failures hidden by test changes.
2. Run the ordinary OpenAI/Responses JavaScript client against the gateway
   using a session capability as its API key and the gateway `/v1` base URL.
3. Run `npm run verify:full` and
   `npm run test:integration:omnigent`, then perform one manual real-Codex
   browser composition.
4. Update the capability inventory and accept ADR 0010 only if all replacement
   gates pass.
5. Delete the browser-visible `/v1/sessions/:id/stream` and `/events` routes,
   `OmnigentProvider`, and superseded custom provider/task wire types. Keep
   internal normalized backend events where they help the response engine.

Checkpoint: the repository has one public task/function protocol, with custom
Agent Connect APIs limited to authorization, session bootstrap, recovery, and
cancellation responsibilities that Open Responses does not standardize.

## Validation contracts

Implementation work should add the following compact contracts before changing
runtime behavior:

| Contract       | Required proof                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `VAL-RESP-001` | accepted/rejected profile matrix plus pinned-schema validation                                            |
| `VAL-RESP-002` | exact JSON and SSE lifecycle for text and one function call                                               |
| `VAL-RESP-003` | ordinary client completes two sequential calls and final text over `previous_response_id`                 |
| `VAL-RESP-004` | wrong Origin, capability, model, snapshot, response chain, or call ID fails closed                        |
| `VAL-RESP-005` | pending call is durable before publication; redelivery and same-output retry preserve its stable ID       |
| `VAL-RESP-006` | disconnect, cancellation, revocation, malformed provider events, and backend failure have stable outcomes |
| `VAL-RESP-007` | browser application uses the new path and the old public task wire is removed only after parity           |

Use the deterministic Omnigent integration as the main oracle. A real model run
is one final composition check, not the routine test loop.

## Stop conditions

Pause and revise the design if any of these occur:

- a standard client requires Agent Connect-specific fields inside a response
  request or response resource;
- the gateway cannot end a response segment at a function call without losing
  the underlying harness execution;
- exact approved tool definitions cannot remain immutable for the chain;
- persistence-before-publication requires encoding Omnigent objects as the
  public source of truth;
- the implementation starts growing a generic backend framework before the
  first concrete backend passes; or
- compatibility requires silently accepting unsupported standard fields.

## Explicitly deferred

- replacing the existing OAuth/enrollment implementation;
- route-framework or broad gateway refactoring;
- WebMCP tool discovery;
- AG-UI, WebSocket, compaction, `store: false`, background responses, or
  provider-hosted tools;
- dynamic tool-snapshot mutation;
- a second harness backend or generalized multi-agent orchestration; and
- one-click deployment changes.

## Sources

- [Open Responses specification](https://www.openresponses.org/specification)
- [Open Responses API reference](https://www.openresponses.org/reference)
- [Open Responses compliance suite](https://www.openresponses.org/compliance)
- [Open Responses source repository](https://github.com/openresponses/openresponses)
- [OpenAI Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI function calling guide](https://developers.openai.com/api/docs/guides/function-calling)
