# VAL-RESP-002: The event lifecycle is standard, ordered, and self-labelling

Surface: protocol.
Needs: the pinned Open Responses document and a deterministic backend.
Behavior: a text segment emits `response.created`, `response.in_progress`, the
message item and content part lifecycle, deltas, and `response.completed`,
terminated by `data: [DONE]`. A segment that ends at an application function
call emits the function item lifecycle and then completes, because that
response segment is complete even though the logical run is not. Every SSE
frame carries an `event:` value equal to the JSON `type`, and
`sequence_number` increases monotonically without repeats within a segment.
Evidence: `packages/gateway/test/responses-engine.test.ts` asserts the exact
event type order for both shapes and validates each event against its pinned
streaming-event schema; `responses-route.test.ts` parses the real SSE body from
the HTTP server and asserts the `event:`/`type` equality and the terminal
`[DONE]` frame.
Fail: an event is emitted out of order, a sequence number repeats or decreases,
the `event:` line disagrees with the payload `type`, or a stream ends without a
terminal event and `[DONE]`.
Scope: the upstream parser does not enforce `event:`/`type` equality, so that
stronger contract is asserted locally and cannot be delegated to the compliance
suite.

## Current status

Passed on 2026-08-28.
