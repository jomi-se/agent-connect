# Future task: multi-turn task continuation

Status: proposed, not started. Written 2026-08-30 after the first real
application (a shopping list) hit the limitation.

## The gap

An application can run a task and get a result. It cannot then say "not quite,
change this" and have the agent continue. Every `AgentSession.streamTask()`
starts a fresh conversation, so a correction is a cold restart: the agent has no
memory of what it just proposed or why.

This is the first thing a real application asked for after the happy path
worked, which is a reasonable signal about its priority.

## Why `previous_response_id` does not already do this

`previous_response_id` exists and is used today, but it means one specific
thing: **delivering a function call output into a run that is parked waiting for
it**. It is not a general "continue the conversation" mechanism.

Three facts in the current implementation:

1. `ResponsesProvider.streamTask` clears `latestResponseId` at the start of
   every task (`packages/web-sdk/src/responses-provider.ts:63`) and sends no
   `previous_response_id` in its opening body. Chaining is strictly intra-task.

2. `ResponseEngine.startContinuation(session, previousResponseId, callId,
output)` requires a `callId` and an `output`, and `resolvableCall` matches
   them against a parked call. There is no path that accepts new user text.

3. `resumableChain` requires a live run, and normal completion is
   `finishChain(chainId, "terminal", null)`
   (`packages/gateway/src/responses/engine.ts:419`), which deletes the active
   state and closes the run. A chain that finished successfully is terminal, and
   `resumableChain` rejects terminal chains.

So continuation after completion is not merely unwired. It is deliberately
closed off by the chain lifecycle.

## Why it is nonetheless feasible

The layer underneath already supports it. `OmnigentBackendRun` posts to
`${sessionUrl}/stream` with `content: [{ type: "input_text", text }]`, and the
Omnigent **session** outlives the run. A run is one prompt turn on a session
that can take another.

So a second user turn is a _new run on the existing provider session_, seeded
with new text. That is a different code path from delivering a tool output into
a parked run, and it does not require anything new from the harness.

## What it would take

**Protocol.** The Open Responses profile must accept text input alongside
`previous_response_id`. Today that pairing implies `function_call_output`.
Decide whether a follow-up turn is the same shape with a different input item,
or a distinct request that names the chain it extends.

**Chain lifecycle.** This is the substantive part. "Terminal" currently conflates
two states that would have to be separated:

- _this turn ended_ — the run finished, the session is alive, another turn is
  possible; and
- _this chain is dead_ — cancelled, interrupted, or backend gone.

Everything downstream of that distinction needs revisiting: when a provider
session is closed, what reclaims an abandoned one, how long a continuable chain
is retained, what `busy` means between turns rather than within one, and how
cancellation behaves on a chain that is idle but continuable.

**Durability.** The reliability work already landed (`e93bd2c`, `1a051d6`,
`6a81261`) assumes a chain is a single run. Persist-before-publication, the
busy-claim, and interruption recovery all need re-examining against a chain that
spans several runs with gaps in between.

**SDK.** The smallest part. Stop clearing `latestResponseId` unconditionally,
accept a continuation on `AgentProviderTaskRequest`, and expose it on
`AgentSession` — probably as an explicit `continueTask(prompt)` rather than a
flag on `streamTask`, so a caller cannot continue by accident.

## Risks

- The response engine is the public boundary and the most safety-critical
  component. This change touches its lifecycle invariants, not its edges.
- A session held open between turns is a resource an application can leak by
  walking away. Needs an idle timeout with defined semantics for a client that
  returns after it fires.
- Longer-lived chains mean more state per grant. Worth bounding before, not
  after.

## What applications can do meanwhile

Replay explicit state into the next prompt. The shopping list does this: it
keeps its proposal buffer across runs and re-states what is staged, including
what the user rejected, so a correction turn re-derives from app data instead of
from the agent's context.

That is not a workaround so much as a different trade. State the application
owns can be inspected, tested, and shown to the user; a context window cannot.
For applications whose state is small and explicit, it may stay the better
option even after continuation exists. This feature matters most where the
valuable context is the agent's _reasoning_ rather than its output — long
analyses, multi-step investigations, anything where re-deriving is expensive.

## Open questions

1. Is a follow-up turn a new response chain that references its predecessor, or
   the same chain extended? The answer drives storage and the grant model.
2. Should the application be able to change the lent tool set between turns? The
   snapshot is currently frozen per chain, and WebMCP will make this pressing —
   see `docs/research/2026-08-27-open-responses-webmcp-handoff.md`.
3. Does a continued turn re-check the grant, or inherit the first turn's
   authorization? Inheriting is simpler; re-checking is safer if a grant can be
   revoked mid-conversation.
