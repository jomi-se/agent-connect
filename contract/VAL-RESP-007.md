# VAL-RESP-007: Disconnect, cancellation, and failure have stable outcomes

Surface: protocol.
Needs: a deterministic backend and the response engine.
Behavior: a client close after a committed function boundary does not cancel
anything, because the parked run is the point of the design. A close during
ordinary generation requests best-effort cancellation and never forces a
terminal status of its own. An explicit cancel wins only before a terminal
commit; a cancelled chain refuses further continuation with
`response_cancelled`. A harness failure produces an `error` event followed by
`response.failed`, keeping text already observed in the resource. A harness
whose transport dies mid-run fails the segment with `backend_unavailable`
rather than hanging. A chain whose harness run is gone resolves to
`interrupted`, never to a silently substituted provider session.
Evidence: `packages/gateway/test/responses-engine.test.ts` covers harness
failure, transport death, cancellation of a parked chain, an unapproved
function name, and the interrupted outcome;
`packages/web-sdk/test/responses-provider.test.ts` covers browser-side
cancellation of a chain parked on an unanswered call.
Fail: a disconnect after a function boundary destroys the run, a cancel
overrides a committed completion, a failure leaves the stream without a
terminal event, or a lost run is transparently replaced.
Scope: cancellation reaching a real Codex run through Omnigent is not yet
proven; only the gateway-side precedence is.

## Current status

Passed on 2026-08-28 for the deterministic backend. Explicit cancellation
against real Omnigent remains open.
