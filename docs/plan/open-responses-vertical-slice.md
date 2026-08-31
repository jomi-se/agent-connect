# Open Responses vertical-slice implementation plan

Updated: 2026-08-29

## Outcome

Prove that the existing Agent Connect gateway can present one useful, bounded
subset of Open Responses in front of the already working Omnigent -> Codex
runtime. The proof must complete a real multi-step application-function loop;
it is not a route-renaming exercise.

The public surface is a **compatible façade with a documented constant
profile**, not a claim that every field it must return is meaningful. See
[Required response fields and the constant profile](#required-response-fields-and-the-constant-profile).

This plan deliberately leaves the existing authorization ceremony, gateway
session provisioning, Omnigent supervision, and fixed approved tool snapshot
in place. Broad route-framework work, generalized harness abstractions, OAuth
replacement, WebMCP, and a second backend wait until this slice is proven.

The implementation has two decision gates:

1. **Protocol-fit gate:** a standard Responses client can create and continue
   responses through multiple sequential application function calls while the
   same Omnigent/Codex execution remains alive.
2. **Real-flow gate:** the actual browser application completes that same loop
   through the private gateway and a subscription-authenticated Codex runtime.
3. **Replacement gate:** the response and pending-call state is durable,
   cancellation/recovery behavior is explicit, the browser SDK uses the new
   path, and the old public task/event wire can be deleted.

[ADR 0010](../decisions/0010-open-responses-gateway-pivot.md) remains proposed
until the replacement gate passes.

## Investigation baseline

### What worked at the investigation baseline

- `packages/gateway/src/gateway.ts` authenticates the browser Origin, checks a
  revocable application grant, creates an opaque application session, and
  issues a short-lived session capability.
- The application session is already bound to the canonical hash of the exact
  approved function definitions. A different snapshot cannot reuse it.
- `packages/gateway/src/omnigent-runtime.ts` provisions one Omnigent session
  and writes the approved application function names into its private policy.
- The original `packages/web-sdk/src/omnigent-provider.ts` opened one Omnigent SSE stream,
  posts a prompt and function definitions, submits correlated function
  outputs, and leaves the underlying Codex turn alive across multiple calls.
- `packages/web-sdk/src/agent-session.ts` validates arguments, executes the
  application-owned handler, serializes its output, and suppresses a repeated
  action ID within one in-memory task.
- `packages/gateway/test/omnigent-real.integration.test.ts` is the behavioral
  oracle: disposable real Omnigent services plus a deterministic ACP agent
  already prove the multi-call application-function loop without consuming a
  model credential.

### Gaps identified at the investigation baseline

- The gateway originally proxied Omnigent bytes on
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

- upstream repository commit
  `92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c`;
- the document `public/openapi/openapi.json` at that commit, which declares
  OpenAPI `3.1.0` and `info.version` `2026-04-24`;
- the vendored fixture
  `contract/open-responses/openapi.json`, checksum
  `sha256:693f26090d206230ed22b336681f547a2882cf5b131e86743966cf71bbdeedab`,
  asserted by `packages/gateway/test/open-responses-fixture.test.ts`; and
- the specification, reference, and compliance suite available on 2026-08-27.

There is no upstream artifact numbered `2.3.0`. Earlier drafts of this plan and
of ADR 0010 cited that version; it was not traceable to any primary source at
the pinned revision and has been replaced by the commit plus the document's own
`info.version`. Every schema claim in this plan must cite the pinned document,
not remembered protocol semantics.

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
- Two ingress profiles, decided in
  [ADR 0009](../decisions/0009-separate-ingress-owner-authentication-and-application-authorization.md):
  - **browser**: an ambient `Origin` header is mandatory, must be allowlisted,
    and must equal the capability's signed `origin` claim. Unchanged from today.
  - **standard client**: `Origin` is absent. Accepted only when the transport
    principal is present, the bearer is a valid session capability, and the
    underlying grant carries the explicit non-browser consent bit.
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

### Canonical function projection

Three shapes are involved and they are not the same shape. Version 0 must
define one projection between them or the hash will not mean what the consent
screen said.

| Shape                                     | Required properties                                   |
| ----------------------------------------- | ----------------------------------------------------- |
| Agent Connect `GatewayToolDefinition`     | `name`, `description`, `inputSchema`                  |
| Pinned `FunctionToolParam` (request side) | `name`, `type`                                        |
| Pinned `FunctionTool` (returned resource) | `type`, `name`, `description`, `parameters`, `strict` |

Rules for version 0:

- `strict` is **fixed by the Agent Connect profile at `true`**. It is not part
  of consent and not part of the hash. The user approves a schema, not a
  validation mode. A request that supplies a different `strict` value is a
  `tool_snapshot_mismatch`, not a new configuration.
- `description` and `parameters` are required on the returned resource and are
  projected from the approved snapshot's `description` and `inputSchema`. They
  are never reflected from the request.
- Function names must satisfy the pinned `FunctionToolParam` pattern
  `^[a-zA-Z0-9_-]+$` with a maximum length of 64. The gateway's own snapshot
  validator is narrowed to this charset so an approvable tool is always
  representable on the wire; see the note in Milestone 0.
- Public `call_id` values must satisfy the pinned constraints
  `minLength: 1`, `maxLength: 64`.
- Every response in a chain renders `tools` from the immutable canonical
  snapshot, including continuations that omitted `tools`. A continuation never
  produces an empty tool list.
- Repeated continuation tools are compared **after** canonicalization, never as
  raw JSON.

### Accepted continuation requests

- `model` remains exactly `agent-connect/default`.
- `previous_response_id` identifies either the immediately preceding response
  in a parked function-call chain or the successful durable head of the same
  authorized application session.
- For a parked function call, `input` contains exactly one string-valued
  `function_call_output`, and `call_id` must match that unresolved call.
- For completed-task follow-up, `input` is one user text prompt and starts a new
  immutable chain on the same provider session. See ADR 0011.
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

#### Required response fields and the constant profile

`ResponseResource` at the pinned commit has 31 required properties. Rejecting a
field in a _request_ does not excuse omitting it from a _returned resource_.
They divide into three groups.

The gateway knows these and must render real values: `id`, `object`,
`created_at`, `completed_at`, `status`, `model`, `previous_response_id`,
`output`, `error`, `tools`, `tool_choice`, `store`, `background`, `truncation`,
and `text` (which itself requires `format`).

These are nullable and are emitted as `null` in version 0: `instructions`,
`usage`, `reasoning`, `incomplete_details`, `max_output_tokens`,
`max_tool_calls`, `safety_identifier`, `prompt_cache_key`, and `metadata`.

These six are required, are **not** nullable, and describe sampling and service
behavior that a harness-backed gateway does not control. Version 0 renders them
as documented schema constants:

| Field               | Constant    | Why it carries no meaning                            |
| ------------------- | ----------- | ---------------------------------------------------- |
| `temperature`       | `1`         | sampling is owned by the user's harness              |
| `top_p`             | `1`         | sampling is owned by the user's harness              |
| `presence_penalty`  | `0`         | not exposed by the harness                           |
| `frequency_penalty` | `0`         | not exposed by the harness                           |
| `top_logprobs`      | `0`         | the gateway does not surface logprobs                |
| `service_tier`      | `"default"` | Agent Connect is single-tier and has no billing tier |

Open Responses standardizes the OpenAI Responses parameter surface, including
sampling and service fields, and makes them required rather than optional. An
implementation whose backend is a coding harness cannot supply meaningful
values. These constants satisfy the required-field contract and are documented
as inert.

This is why version 0 is described as a **compatible façade with a documented
constant profile** rather than an "honest subset": the subset of _behavior_ is
honest, but the response resource necessarily carries required fields that do
not describe anything the gateway decides.

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

Persist only state the gateway owns. The durable chain record must be
sufficient to **reconstruct authority** after a restart without consulting
process memory, so it carries more than an ID mapping:

- chain ID, application session ID, and chain status;
- application ID, normalized origin, and authorization grant ID;
- approved tool hash **and** the immutable canonical tool definitions, or a
  content-addressed reference to them;
- provider kind and provider session ID;
- each response ID, previous response ID, normalized input, output items,
  status, timestamps, and terminal error;
- each public call ID, private provider token, tool name, arguments, owning
  response, state, and optional result fingerprint; and
- cancellation/failure state.

Application ID, origin, grant ID, and canonical definitions are the fields the
earlier draft omitted. Without them a restarted gateway can know that a
response mapped to a provider session but cannot prove which still-active grant
authorized it, and therefore cannot enforce revocation on recovery.

#### Call state is three axes, not one

`pending -> delivered -> resolved` conflates two independent delivery problems:
publishing a call to the application, and getting a result accepted by the
provider. It has nowhere to record "output persisted but not yet posted."
Version 0 uses three orthogonal durable axes:

```text
publication: recorded -> publication_started -> published
result:      none -> output_recorded -> delivery_attempted -> provider_observed
chain:       running | waiting_for_output | cancelling | terminal
```

Rules:

- the `recorded` publication state must reach durable storage before the call's
  SSE event is written;
- the canonical output must be persisted before the provider is contacted;
- a same-output retry returns the existing record and may safely redrive
  provider delivery; a different output conflicts from `output_recorded` onward;
- a provider `202` acknowledgement is **not** proof of effect. The result is
  not `provider_observed` until provider transcript reconciliation or a
  subsequent response item proves it; and
- transitions are serialized per chain.

This is idempotent result submission, not a claim of exactly-once application
side effects. An idempotent application operation, or application-owned
deduplication, is still required.

### Recovery contract

"Reattach when possible" is not an algorithm. Every recovery attempt must
resolve to exactly one of three outcomes the version 0 implementation can
actually produce:

| Outcome                  | Meaning                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `reattached_live`        | the original in-process run is still alive                 |
| `terminal_reconstructed` | a persisted terminal public response resource is returned  |
| `interrupted`            | stable terminal error; never a silent provider replacement |

`reconciled_from_snapshot` was removed after implementation review because no
code path could produce it. Omnigent exposes useful history and liveness, but
version 0 does not reconstruct a lost gateway-side event subscription from
that snapshot. A documented recovery outcome that cannot occur is misleading.

#### What the snapshot does and does not provide

Measured against real Omnigent 0.5.1 by the Milestone 0.5 spike, not inferred
from source. `GET /v1/sessions/{id}` provides:

- `runner_online` and `status` (`idle | running | waiting | failed`) — reliable
  liveness for the retained run; and
- `items` — committed conversation items in chronological order, each with an
  item id, which is the deduplication key for replaying missed output.

It does **not** provide the unresolved application call. While a call was
parked, the spike observed `pending_elicitations: []`, `pending_inputs: []`,
`active_response_id: null`, and no `function_call` item. `pending_elicitations`
tracks approval prompts, not application MCP tool calls; an application call is
an in-flight `tools/call` inside the runner and never becomes a committed item.

An earlier revision of this plan claimed the opposite. It was wrong, and the
spike exists to catch exactly that class of error.

The consequence is load-bearing: **the gateway's own
persist-before-publication record is the only source of truth for unresolved
calls.** Omnigent cannot corroborate it, and the durable ledger must be treated
as authoritative rather than as a cache to be validated against the provider.

#### The limit of recovery, stated plainly

A parked application call is an in-process awaiter inside the **Omnigent**
process, not inside the gateway. `omnigent/runtime/pending_elicitations.py`
states that the index "lives alongside the underlying parked awaiter ... and
shares its lifecycle: when the Omnigent process dies, both the index and every
parked awaiter die together." It is in-memory only.

Therefore both a gateway process restart and an Omnigent process death are
terminal for an in-flight version 0 run. No amount of gateway-side durability
restores the lost event iterator or the provider's parked awaiter. The chain
resolves `interrupted` rather than being silently replaced.

`interrupted` is a first-class terminal state of the version 0 profile, not an
edge case. Milestone 5 must not promise recovery it cannot deliver.

Say the resulting contract exactly, because "recovery" overstates it. After a
gateway restart the gateway **reconstructs its own record** of a chain and
**detects** whether the chain can go on. It does not reattach to a run it no
longer holds: nothing in version 0 re-establishes an event stream over a
pre-restart Omnigent run, so a chain whose parked call outlived the gateway
process resolves `interrupted`, and the durability tests assert exactly that.
What persistence buys is that the chain's outcome is _known_ and its unresolved
call is _not silently replayed_ — not that the conversation continues. The
three recovery outcomes are answers about state, not three ways of resuming.

A chain is only ever counted as live if its harness run answers `isAlive()`.
A non-terminal chain whose run did not survive is retired to `interrupted` at
the moment anything asks — a new response, or the capability refresh that would
repair the session. Leaving it standing would block both, permanently, since
nothing else would ever look at it again.

The gateway's generic provider-session repair (`ensureHealthy` in
`packages/gateway/src/gateway.ts`) currently mints a replacement provider
session in place. That is acceptable for today's stateless task route and
**invalid for an active response chain**, whose private call IDs belong to the
old provider session. Transparent replacement is forbidden for a chain that is
running or waiting for output; such a chain transitions to `interrupted`.

### Cancellation, disconnect, and revocation precedence

The current gateway couples `ServerResponse` close directly to an
`AbortController` for the upstream stream. The new ownership boundary removes
that coupling, which means close, cancel, completion, and revocation can now
race. Version 0 fixes precedence:

- a client close after a **committed function boundary** does not cancel
  anything; the parked run is recoverable and that is the point of the design;
- a client close during ordinary generation requests best-effort cancellation,
  but may still settle as `completed` if completion was already committed;
- an explicit cancel wins only **before** a terminal commit;
- provider events observed after a terminal commit are audit-only and never
  change the published status;
- grant revocation blocks all new continuation, output submission, and
  recovery, and either triggers best-effort cancellation of the active run or
  is documented to take effect at the next authorization boundary — version 0
  chooses one and tests it; and
- exactly one durable public terminal status is committed per chain.

Two admission rules follow from the same boundary, and both are enforced in
`ResponseEngine`:

- **One live chain and one linear history per application session.** The
  session's provider session is a single harness conversation. A concurrent
  chain is `response_busy`; after the initial task, a later user turn must name
  the successful durable head. An unlinked second initial request is invalid.
- **One operation at a time on a chain**, claimed in the same synchronous step
  as the check that guards it. A claim taken after the intervening `await`s
  would let two continuations pass together and deliver two outputs for one
  parked call.

Abandonment is decided by chain state, never by who is listening. A chain
parked on a call keeps running whether or not a browser holds a request open,
which is the entire point of separating run ownership from the HTTP request.
What _is_ bounded is delivery: a call is offered to the application only while
its chain is `running` or `waiting_for_output`. Once the chain is cancelling,
cancelled or interrupted, the parked call stays in the ledger as an unresolved
record but stops being redelivered, because its result could never be taken.
An application that has already started the side effect may still finish it;
the gateway's guarantee is that it will not _ask_ for one it cannot use.

The file-backed store is defined as single-process, atomic, and fsync-backed.
The existing auth store's temporary-file-plus-rename is not sufficient on its
own for the persistence-before-publication guarantee.

## Implementation sequence

Milestones 0 through 3 and the durability core of Milestone 5 are implemented.
What remains is listed under [Remaining work](#remaining-work).

### Milestone 0: narrow the tool-name charset

`packages/gateway/src/tool-snapshot.ts` accepts `^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`,
which permits `.`. The pinned `FunctionToolParam.name` pattern is
`^[a-zA-Z0-9_-]+$`. A tool named `app.doThing` is approvable today and
unrepresentable on the Open Responses wire.

No shipped application uses a dotted name, so this is currently latent. Narrow
the validator now, before any grant persists a hash over a name that the wire
cannot carry; afterwards the same change would require migrating user consent.

Checkpoint: the snapshot validator rejects names outside the pinned charset and
existing tests still pass.

**Done** in `packages/gateway/src/tool-snapshot.ts`, covered by
`packages/gateway/test/tool-snapshot.test.ts`, which cross-checks every accepted
name against the pinned `FunctionToolParam.name` pattern.

### Milestone 0.5: disposable Omnigent ownership spike

Run this **before** building the general engine. It is the cheapest way to fail,
and it is the only architecture-specific unknown in the plan. It is disposable
code and is not merged as a component.

Prove, against real Omnigent and the deterministic ACP agent:

1. a gateway-owned reader survives the close of the client-facing segment;
2. two sequential application calls complete on one retained run;
3. an explicit cancel reaches the run;
4. the same output submitted twice does not double-apply;
5. after killing the gateway process, `GET /v1/sessions/{id}` plus
   `subscribe(pre_ready_snapshot=...)` reconstructs the chain with no duplicate
   public item IDs; and
6. killing the Omnigent process yields a deterministic `interrupted`, not a
   hang.

Stop condition: if 1, 2, or 5 cannot be demonstrated, stop and evaluate the
Codex app-server fallback before writing the engine. Do not distort the public
profile around an Omnigent limitation.

#### Spike results, run 2026-08-27 against Omnigent 0.5.1

Implemented as `Omnigent ownership spike (Milestone 0.5)` in
`packages/gateway/test/omnigent-real.integration.test.ts`. It drives Omnigent
directly rather than through the gateway, because today's gateway still aborts
the upstream stream on client close — the exact coupling the new backend
removes. Passing.

Demonstrated:

1. **The run survives a deliberate mid-run stream detach.** After abandoning the
   SSE reader while a call was parked and waiting 20 s, the session still
   reported `status: running` and `runner_online: true`.
2. **Two sequential application calls complete on one retained run**, with
   distinct provider call IDs, followed by the run's own completion.
3. **A private call ID is not bound to the connection that delivered it.** Each
   output was submitted on a different HTTP connection from the one that
   observed its call, and each was accepted. This is the property a restarted
   gateway needs in order to redrive a persisted output.
4. **A repeated output for an already-resolved call is accepted as a no-op**
   (`202`) and does not double-apply.

Demonstrated afterwards, once the engine existed to drive it:

5. **Explicit cancellation reaches the run without depending on a provider
   terminal event** (item 3 above). Re-run on 2026-08-28 through the gateway's
   cancel extension against real Omnigent while the deterministic ACP agent was
   deliberately still busy. The public SSE stream ended as cancelled and the
   Omnigent session stopped running. The engine also proves locally that a
   parked call cannot be resurrected or offered after cancellation.
6. **Gateway restart reconstruction** (item 5) is proven at the HTTP layer by
   restarting a real gateway over the same durable state. A later process
   fixture SIGKILLs an actual gateway child at all four output/call commit
   boundaries and proves deterministic reconstruction from the durable files.
7. **Real Omnigent process death is deterministic.** The isolated integration
   fixture kills the Omnigent server while a gateway chain is parked. The live
   gateway reports `interrupted`, offers no stale call, and rejects continuation
   with `backend_unavailable` instead of hanging or replacing the session.

The decisive negative finding — that the snapshot does not report the parked
call — is recorded under
[What the snapshot does and does not provide](#what-the-snapshot-does-and-does-not-provide)
and is asserted by the spike so that a future Omnigent change fails the test.

Verdict: **go.** The three properties the architecture actually depends on —
retained run across a closed public segment, two sequential calls, and
connection-independent call IDs — all hold.

### Milestone 1: executable profile contract

1. Pin the upstream version/commit and derive a small, committed test fixture
   containing only the response resource and events used by version 0.
2. Implement the request parser, normalized internal command, response/event
   builders, SSE encoder, and stable error mapping.
3. Add table-driven tests for every accepted and rejected field combination.
4. Validate produced JSON resources and SSE events against the pinned schemas.

Checkpoint: deterministic unit tests prove that the gateway emits standard
shapes and fails unsupported features explicitly. No Omnigent code changes yet.

**Done.** The document is vendored at `contract/open-responses/openapi.json` and
its checksum asserted. `packages/gateway/src/responses/` holds `profile.ts`,
`protocol.ts`, `segment-writer.ts`, `sse.ts`, and `errors.ts`; the accept/reject
matrix is `test/responses-profile.test.ts`, and produced resources and events
are validated against the pinned schemas by the evaluator in
`test/support/openapi-schema.ts`. See
[VAL-RESP-001](../../contract/VAL-RESP-001.md) and
[VAL-RESP-002](../../contract/VAL-RESP-002.md).

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

**Done, and the gate is passed.** `responses/engine.ts` and
`responses/store.ts` hold the state machine; `omnigent-response-backend.ts` owns
the upstream stream independently of any browser request; `response-routes.ts`
mounts `POST /v1/responses` from `gateway.ts`. Run on 2026-08-28 against real
Omnigent 0.5.1, `Open Responses through the gateway` in
`test/omnigent-real.integration.test.ts` completed three response segments
joined only by `previous_response_id`, with two sequential application calls and
final model text, on **one** provider session, and with no `action_required`,
provider session id, or ACP event reaching the client.

One translation rule was needed and is not obvious: Omnigent emits
`response.completed` when a _provider_ response ends, including the one that
parked an application call. The backend suppresses it while a call is
outstanding, because forwarding it would complete the public chain while the
browser still owes a function output.

If Omnigent cannot safely retain or reattach the waiting stream, stop here and
test the same engine against the documented Codex app-server fallback. Do not
distort the public profile around an Omnigent limitation.

### Milestone 3: browser SDK migration

1. Implement `ResponsesProvider` using standard response requests and events.
2. Preserve the current `connectAgent()`, tool execution, and `runTask()` user
   experience while chaining response segments internally.
3. Put the Responses provider behind an explicit opt-in flag. It does **not**
   become the `connectAgent()` default at this milestone.
4. Add browser-safe tests for streaming, cancellation, tool errors, repeated
   calls, and no Node-only imports.

The default switch moves to Milestone 5, after durability. Making the new path
the default before pending-call recovery, restart reconstruction, and
capability refresh exist would regress recovery against the plan's own stated
priority and would expose non-idempotent application functions to known
disconnect loss.

Checkpoint: the Canvas application completes its existing user flow through
`/v1/responses` with the flag enabled; no browser package imports Omnigent wire
types for the new path.

**Done for the SDK.** `packages/web-sdk/src/responses-provider.ts` implements
the continuation loop behind the neutral `AgentSession` API. It was initially
opt-in for Milestone 4; after the durability and replacement gates it became
the only `connectAgent()` wire in Milestone 6. The package smoke test scans the
browser sources for `node:` imports; the package tsconfig omits Node types,
which catches globals but not an explicit `node:` specifier.

### Milestone 4: real browser-to-Codex composition

**Run twice on 2026-08-28 and passed.** It consumes the operator's model
allowance and needs a real browser, so it is a deliberate human-run gate rather
than a routine build check.

The run drove the Firebase canvas against the private Tailscale Serve profile
and the operator's real Codex login. Codex called three application functions
in sequence — `get_current_app_state`, `update_project_tasks`,
`move_project_tasks` — each answered by the browser as a
`function_call_output` continuation, ending in final Codex text and a visibly
mutated board. The four `POST /v1/responses` requests carry the expected
shapes: the first with the ten-function snapshot and no `previous_response_id`,
the three continuations with `previous_response_id` and no tools. No
Omnigent-shaped value reached the page. Evidence is kept out of the repository
under `.agent-connect/evidence/`.

The first run found that `?protocol=open-responses` did not survive a **first-time**
authorization. The gateway returns the browser to a callback URL it composes
itself, carrying `code` and `state` and nothing of the application's, and the
canvas then tidied the address bar down to `location.pathname`. A visitor who
had never authorized therefore reconnected on the default wire, and the run
only reached the Responses path because the grant already existed. The canvas
now remembers the requested wire for the duration of the redirect and restores
it on the callback only. The second run explicitly cleared both local and
session storage, completed consent once, returned directly on Open Responses,
then completed three real Codex function calls and the visible board mutation
with no fallback reconnect, console error, or page error. See
[VAL-RESP-004](../../contract/VAL-RESP-004.md).

Run the complete private deployment flow before investing in the durability
layer:

1. Start the source-installable gateway and Omnigent stack using the existing
   private Tailscale Serve profile and the operator's real Codex login.
2. From the actual browser application, verify gateway identity, complete the
   existing authorization ceremony, approve the exact function snapshot, and
   obtain an opaque application session.
3. Create the first response through `/v1/responses`; require Codex to invoke
   at least two sequential application-owned functions.
4. Execute both functions in the browser, continue through
   `previous_response_id` after each output, and receive final Codex text.
5. Confirm the browser sees only standard Responses objects/events and opaque
   Agent Connect identifiers—never Omnigent session IDs, `action_required`,
   ACP messages, or provider request tokens.
6. Capture a scrubbed transcript containing response IDs, public call IDs,
   event ordering, continuation boundaries, final completion, gateway logs,
   and the browser result. Do not retain prompts, credentials, authorization
   codes, bearer capabilities, private tool results, or provider tokens.

Checkpoint: one real human-visible browser interaction proves the entire path:

```text
browser application
  -> gateway authorization and approved snapshot
  -> POST /v1/responses
  -> Omnigent
  -> subscription-authenticated Codex
  -> application function call
  -> browser handler
  -> function_call_output continuation
  -> Codex final response
  -> browser UI
```

This is the real-flow decision gate. If it fails, fix the narrow slice or
reconsider the backend before implementing persistence. Because it consumes
the operator's model allowance, run it once after deterministic integration is
green rather than on every build.

### Milestone 5: durability, recovery, and cancellation

1. Replace the in-memory store with the narrow file-backed store and atomic
   updates.
2. Reconstruct chain authority on gateway restart from the durable record
   alone, and implement the three declared recovery outcomes. Forbid transparent
   provider-session replacement for an active chain.
3. Add three explicitly Agent Connect control operations, addressed by an
   opaque response ID:
   - `GET /v1/agent-connect/responses/:responseId` to retrieve chain status and
     the latest complete public response;
   - `GET /v1/agent-connect/responses/:responseId/pending-function-calls` to
     retrieve/redeliver unresolved application function calls; and
   - `POST /v1/agent-connect/responses/:responseId/cancel` to cancel the
     logical response chain and propagate interruption downstream.

   The chain resource is required because a pending-call list cannot recover a
   response that _completed_ during an outage: the list is simply empty, and
   empty is indistinguishable from "still running". All three are Agent Connect
   extensions; the standard `/v1/responses` profile is unchanged.

4. Check grant revocation on continuation, recovery, and cancellation.
5. Implement capability refresh for a live chain, or a declared bounded maximum
   chain lifetime that fails explicitly. The current one-hour capability with no
   refresh path is not sufficient for a long chain.
6. Add crash-point tests that kill an actual gateway process — not only throw
   between in-memory operations — at each commit boundary: after output
   persistence and before POST, after POST and before acknowledgement, after
   acknowledgement and before the local transition, and after the provider
   emits the next item.
7. Only after the above pass, make the Responses provider the `connectAgent()`
   default and retain the old Omnigent provider as an explicitly transitional
   test path.

Checkpoint: a disconnect or gateway restart cannot silently lose an already
published unresolved call, a response completed during an outage is
retrievable, duplicate output submission is deterministic, Omnigent process
loss yields a deterministic `interrupted`, and cancellation reaches
Omnigent/Codex where the backend supports it.

**Steps 1, 2, 3, and 4 are done.** `responses/file-store.ts` is single-process,
atomic, and fsync-backed on both the file and its directory entry; the index is
rebuilt from the chain files at startup. `gateway.ts` rehydrates the application
sessions that chains belong to from those records alone, including terminal
chains, so a capability for an existing chain no longer gets a bare 401 that
hides whether the chain is recoverable, complete, or interrupted. The response
routes never call `ensureHealthy`, so no active chain is handed a replacement
provider session. See [VAL-RESP-006](../../contract/VAL-RESP-006.md).

Step 5 is done by making the existing capability refresh safe rather than by
adding a new mechanism: `POST /v1/app-sessions` already re-issues a capability
for a live session, but it also repaired the provider session, which is exactly
the transparent replacement a chain cannot survive. It now skips the repair when
the session still has a non-terminal chain, so a long chain can refresh its
capability without losing its call IDs.

Step 6 is done by `responses-process-crash.integration.test.ts`, which kills an
actual gateway child at each of the four named commit boundaries and restarts
over the same durable state. Step 7 is done under VAL-RESP-008: Open Responses
is the sole browser wire and the legacy provider is removed.

### Milestone 6: conformance, replacement, and deletion

1. Run the applicable upstream compliance tests: basic text, streaming, and
   function calling. Record the unsupported upstream cases as profile
   exclusions rather than failures hidden by test changes.
2. Run the ordinary OpenAI/Responses JavaScript client against the gateway
   using a session capability as its API key and the gateway `/v1` base URL.
3. Run `npm run verify:full`—which includes the real-Omnigent compatibility
   gate—and then repeat the Milestone 4 real browser-to-Codex composition as
   the final replacement check.
4. Update the capability inventory and accept ADR 0010 only if all replacement
   gates pass.
5. Delete the browser-visible `/v1/sessions/:id/stream` and `/events` routes,
   `OmnigentProvider`, and superseded custom provider/task wire types. Keep
   internal normalized backend events where they help the response engine.

Checkpoint: the repository has one public task/function protocol, with custom
Agent Connect APIs limited to authorization, session bootstrap, recovery, and
cancellation responsibilities that Open Responses does not standardize.

**Default and deletion implemented on 2026-08-29.** The neutral SDK convenience
events remain local API types, not a gateway wire. `npm run verify:full` now
includes the process-crash suite. The final post-switch private browser/Codex
composition is the remaining acceptance action for ADR 0010.

## Validation contracts

Implementation work should add the following compact contracts before changing
runtime behavior:

Written contracts live in `contract/`. Status as of 2026-08-29: `VAL-RESP-000`
through `007` passed; the automated portion of `VAL-RESP-008` is implemented,
with its final private browser/Codex composition pending.

| Contract       | Required proof                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAL-RESP-000` | Omnigent ownership spike: retained run, two calls, cancel, restart reconciliation, deterministic `interrupted`                                |
| `VAL-RESP-001` | accepted/rejected profile matrix plus validation of complete resources against the pinned schema                                              |
| `VAL-RESP-002` | exact JSON and SSE lifecycle for text and one function call, including `event:` equal to the JSON `type`                                      |
| `VAL-RESP-003` | an unmodified OpenAI client with only `baseURL` and `apiKey` completes two sequential calls and final text                                    |
| `VAL-RESP-004` | real browser -> private gateway -> Omnigent -> Codex -> two browser functions -> final browser result                                         |
| `VAL-RESP-005` | wrong Origin, capability, model, snapshot, response chain, or call ID fails closed; canonical-projection equivalence classes hash as intended |
| `VAL-RESP-006` | pending call is durable before publication; redelivery and same-output retry preserve its stable ID; process-kill crash points recover        |
| `VAL-RESP-007` | disconnect, cancellation, revocation, malformed provider events, and backend failure have stable outcomes                                     |
| `VAL-RESP-008` | browser application uses the new path by default and the old public task wire is removed only after parity                                    |

`VAL-RESP-002` asserts `event:` equality locally. The upstream parser does not
enforce that stronger contract, so it cannot be delegated to the compliance
suite.

`VAL-RESP-003` depends on the non-browser ingress profile decided in
[ADR 0009](../decisions/0009-separate-ingress-owner-authentication-and-application-authorization.md),
which is now implemented. It passed on 2026-08-28 with the real `openai` 7.8.0
client, which needed no Agent Connect-specific field and parsed both the JSON
resources and the SSE stream with its own code.

Upstream compliance is one component of the evidence, not a blanket conformance
certificate. The pinned `tool-calling` compliance test checks that a function
call is returned; it does not exercise the function-output continuation chain,
two sequential calls, authorization, or recovery. Those remain local hard gates.

Use the deterministic real-Omnigent integration as the main compatibility
oracle. Pure engine fixtures prove only Agent Connect-owned invariants and
fault handling; they do not model Omnigent. A real model run is one final
composition check, not the routine test loop. The full evidence policy lives in
[the testing strategy](../architecture/testing-strategy.md).

## Remaining work

In rough dependency order:

1. **Milestone 6 final composition**: repeat the private browser-to-real-Codex
   flow on the single-wire build, then accept ADR 0010 and close VAL-RESP-008.
2. **Bounded follow-ups from implementation review**, tracked in the dated
   [review disposition](../reviews/2026-08-28-open-responses-implementation-review.md):
   HTTP backpressure and last-resort post-header SSE errors, browser handler
   deadlines, malformed-argument correction semantics, and an SDK consumer for
   the recovery control routes. These do not reopen the resolved silent
   persistence, cancellation, liveness, or protocol-error bugs.

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
