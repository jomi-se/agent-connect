# 0011: Model completed-task continuation as a linear response history

- Status: proposed; implementation complete, pending manual real-Codex release gate
- Date: 2026-08-31

## Context

The first application needed to correct a completed result without restating
the whole task. Omnigent 0.5.1 already binds one provider session to one durable
ACP session and reuses it across prompts. The missing layer was an honest
application-visible continuation contract.

Reopening a terminal response chain would weaken the existing run, persistence,
and cancellation invariants. Allowing another unlinked initial request would
also be misleading: it would omit `previous_response_id` while still entering
the same stateful provider conversation.

## Decision

Each user turn is a new immutable Open Responses chain. The first response of a
follow-up chain names the latest successfully completed response with
`previous_response_id`. The gateway persists a monotonically increasing turn
ordinal and predecessor ID, and accepts only a linear advance of the durable
session head on the same provider kind, provider session, grant, origin,
application, and fixed tool snapshot.

One opaque application session admits exactly one unlinked initial task. Every
later turn must explicitly continue the current successful head. Failed,
cancelled, interrupted, stale, legacy, or provider-replaced heads are not
continuable. Starting over uses a fresh opaque application and provider session
under the existing grant; capability refresh itself never resets a session.
Fresh creation is independent of earlier sessions, including sessions with
live or parked work. Distinct application sessions may therefore run in
parallel while the one-active-chain rule remains local to each session. The
gateway bounds this to eight unexpired sessions provisioned per grant,
application, and tool snapshot in one process. Each session shares the
capability lease (one hour by default); issuing or refreshing its capability
renews that lease. On expiry the gateway durably retires the opaque session and
best-effort cancels a retained provider run.

The provider-neutral browser SDK represents the predecessor as an opaque
continuation checkpoint. It exposes explicit `streamContinuation()` and
`continueTask()` methods. Starting a turn invalidates the prior usable
checkpoint, and only successful completion publishes the next one.
The SDK freezes the application tool snapshot once per session.

Recovery of a chain parked on an unresolved application function call remains
a separate problem. This decision does not authorize automatic side-effect
replay.

## Consequences

- Completed runs remain terminal and no idle backend run is retained.
- The application cannot fork one stateful provider conversation.
- A client that loses its checkpoint must start a fresh session unless a later
  design adds durable client-side checkpoint restoration.
- Losing browser state does not block a fresh connection and does not imply
  recovery: the abandoned session remains isolated until its lease expires.
- Expiry durably tombstones the opaque session. Complete provider workspace
  deletion beyond closing its retained run remains future lifecycle work.
- Pre-feature response files remain readable but cannot be guessed into a
  continuation order.
- Real-provider compatibility requires one ACP `session/new`, multiple
  `session/prompt` calls on its ID, and a later tool call that depends on
  first-turn-only information.

The executable contracts and evidence plan are in
[`docs/plan/multi-turn-task-continuation.md`](../plan/multi-turn-task-continuation.md).
