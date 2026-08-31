# Multi-turn task continuation

Status: implemented; pending manual real-Codex release gate. Written 2026-08-30.

## Outcome

Let an application finish a task and then explicitly say “continue from that
answer” or “not quite, change this” while retaining the same user-owned agent
conversation. The second turn is a new immutable Open Responses chain linked by
`previous_response_id`; it is not a reopened terminal run.

This milestone proves same-session, completed-turn continuation. It does not
claim that an in-flight browser task survives a disconnect or that an
unresolved application function call can be safely replayed.

## Ground truth

The current stack already has the provider primitive:

- one Agent Connect application session maps to one Omnigent provider session;
- Omnigent 0.5.1 binds that provider session to one durable ACP session and
  reuses it for every prompt;
- `OmnigentBackendRun.close()` closes the turn's SSE subscription, not the
  provider session;
- a later backend `start()` against the same provider session sends another
  prompt into the same Codex conversation.

The current public behavior hides that continuity. `streamTask()` starts a new
Open Responses chain with no predecessor, and the profile only accepts
`previous_response_id` when the input is a `function_call_output` for a parked
run.

## Decisions for the bounded slice

### Every user turn is a new chain

A completed run remains terminal. A text follow-up creates a new chain with:

- its own chain and response IDs;
- `continuedFromResponseId` naming the predecessor response;
- a monotonically increasing `sessionTurn` within the application session;
- the same provider session, grant, origin, application, and frozen tool
  snapshot as its predecessor.

Keeping turns immutable preserves the existing persistence and cancellation
invariants. No idle live run is retained between turns.

### The predecessor must be the durable session head

The gateway accepts a text follow-up only when its `previous_response_id` is the
latest successfully completed response in the latest admitted chain for that
application session. It rejects:

- a response from another session, origin, application, grant, or tool snapshot;
- a non-terminal, failed, cancelled, or interrupted predecessor;
- a stale predecessor after any later chain was admitted;
- a predecessor whose provider session differs from the current mapping;
- two requests racing to advance the same session head.

Exactly one initial task is admitted per opaque application session. Every
later turn must name the current head. An unlinked second request cannot
honestly mean “fresh conversation” when the gateway would send it into the same
durable Omnigent/ACP conversation. Starting over therefore requires a new
application session and provider-session mapping. `connectAgent({ freshSession:
true })` provisions both under the existing application grant; reauthorization
is not required. It refuses to replace a session with live work and allows at
most eight provisioned sessions for one grant, application, and tool snapshot
in a gateway process. The replaced opaque session is retired with a durable
tombstone so its capability cannot be reconstructed after restart;
provider-side workspace expiry and garbage collection remain separate operator
work. Capability refresh remains reuse-only and cannot accidentally reset a
conversation.

After a failed, cancelled, or interrupted turn, the application must also start
a new application session. The gateway cannot know which partial provider
context survived, so neither continuing nor silently treating the next request
as fresh would be honest.

Admission is claimed synchronously per application session before the first
await, then released on every failure. The durable ordinal is computed from the
stored chains while the claim is held. This closes the existing race in which
two initial requests can both pass `requireNoLiveChain()` before either chain
is persisted. The claim remains held through chain persistence,
`backend.start()`, and registration of the active run (or durable terminal
failure). `hasLiveChain()` also observes it so capability refresh cannot replace
the provider session midway through admission.

Version-1 chain files written before this feature load with `sessionTurn: 0`.
They remain readable for recovery but are not valid continuation heads. The
gateway never guesses their order from timestamps.

### The SDK makes continuation explicit

`AgentSession` gains explicit streaming and collected-result continuation
methods. A normal `streamTask()` starts the session's one initial task; it does
not silently turn into a follow-up. The SDK rejects a second initial call
locally. It clones and compiles the approved tool snapshot once at
construction, so caller mutation cannot change browser-side validation or
handlers between turns.

The provider boundary carries an optional opaque continuation checkpoint rather
than an Open Responses-specific response type. A completed provider task publishes a
checkpoint, and `AgentSession` retains only the last successfully completed
one. Starting any next turn invalidates that checkpoint until the turn
completes successfully, because an admitted failed or cancelled turn has still
consumed the former head. Calling continuation without a current completed
checkpoint fails locally.

Persisting a checkpoint across page reloads is deliberately deferred. The
gateway representation is durable, but a reload also has to preserve or renew
the opaque application session capability without replacing its provider
session. That deserves its own end-to-end contract. A client that did not
persist the checkpoint must request a fresh session after reload rather than
reusing a conversation it can no longer continue.

## Scope inventory

| Surface                | Change                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Open Responses profile | Distinguish text follow-up input from function-call output continuation when `previous_response_id` is present.                      |
| Response engine        | Admit a new linked chain on the same provider session; enforce predecessor, terminal-success, head, and concurrency invariants.      |
| Response store         | Persist optional predecessor metadata and a per-session turn ordinal; load older version-1 files compatibly.                         |
| Provider-neutral SDK   | Add an opaque continuation checkpoint and explicit continuation methods.                                                             |
| Session provisioning   | Add an explicit fresh-session option under an existing grant for reset, failure recovery, and reload without a persisted checkpoint. |
| Responses provider     | Send checkpoint as `previous_response_id`; publish the final successful response ID as the next checkpoint.                          |
| Canvas                 | Exercise a visible correction turn without reconnecting or reauthorizing.                                                            |
| Real-provider fixture  | Prove one ACP session receives two completed prompts and retains first-turn information.                                             |
| Documentation          | Correct the former fresh-conversation claim and describe the bounded behavior.                                                       |

## Validation contracts

### VAL-CONT-001 — profile and engine semantics

Given `previous_response_id` plus user text, the gateway starts a new chain on
the predecessor's provider session and the created response names that
predecessor. Function-call-output continuation remains unchanged.

The gateway rejects a second unlinked initial request and rejects foreign,
pending, unsuccessful, stale, consumed, and provider-replaced predecessors.
Exact pre-header errors are:

- unknown or foreign: `previous_response_not_found`, HTTP 404,
  `param: previous_response_id`;
- stale, legacy, unsuccessful, or provider-kind/session-replaced:
  `previous_response_not_continuable`, HTTP 409,
  `param: previous_response_id`;
- concurrent admission or a live task: `response_busy`, HTTP 409;
- unlinked task after the first admission: `invalid_request`, HTTP 400,
  `param: previous_response_id`.

Two racing initial requests, or two racing follow-ups from one head, admit at
most one chain. A capability refresh racing chain admission cannot replace the
provider mapping.

Evidence: parser tests, engine tests, durable-store reload tests, and route-level
streaming and non-streaming tests.

### VAL-CONT-002 — provider-neutral SDK behavior

After a successful task, `streamContinuation(prompt)` and
`continueTask(prompt)` send the retained opaque checkpoint. They fail locally
before any request when no successful checkpoint exists. Starting any turn
clears the prior checkpoint; only successful completion publishes the next one.
Providers that do not publish checkpoints remain source-compatible and cause
continuation to fail locally with `continuation_unavailable`. The active
response ID used for cancellation/recovery remains separate provider state.

Evidence: provider seam tests, AgentSession public API tests, and exact HTTP body
assertions for ResponsesProvider. Fresh-session tests prove a new opaque
application session and provider mapping are created without reauthorization,
refuse replacement during live work, keep the old opaque capability retired
after restart, and enforce the per-grant/application/tool provisioning bound.

### VAL-CONT-003 — real Omnigent continuity

Through the real pinned Omnigent process, two completed application turns use
one provider/ACP session. The fixture observes one `session/new`, two
`session/prompt` calls with the same session ID, and produces a second answer
that depends on a unique marker introduced only in the first turn. The
continued turn must call an approved browser tool using that retained marker.

Evidence: mandatory real-Omnigent integration test included in `npm run verify`.
Fake or recorded provider events are not acceptable evidence for this contract.

### VAL-CONT-004 — real browser correction flow

In the Canvas, a completed task is followed by a user correction on the same
connection. The second request carries the prior response checkpoint, requires
no new authorization, and produces the corrected application result.

Evidence: browser automation on the real UI plus a final manual real-Codex
smoke whose correction depends on prior conversational context rather than only
re-reading application state. The manual real-Codex smoke is an explicit
release gate and is not implied by `npm run verify`.

## Non-goals

- branching or forking one provider conversation;
- changing the approved tool snapshot between turns;
- continuing failed, cancelled, or interrupted turns;
- silently cold-starting after provider-session replacement;
- automatic pending-function-call recovery or side-effect replay;
- reload during generation, transcript replay, or history UI;
- general multi-agent or background-task orchestration.

## Implementation sequence

1. Extend the stored chain metadata and add synchronous per-session admission.
2. Parse and validate text follow-ups separately from function outputs.
3. Start a new backend run on the same provider session and link its first
   response to the predecessor.
4. Add opaque SDK checkpoints and explicit continuation methods.
5. Add the Canvas correction flow.
6. Prove the contracts from narrow unit tests through real Omnigent and browser
   validation, then run independent scrutiny before the default demo is used.
