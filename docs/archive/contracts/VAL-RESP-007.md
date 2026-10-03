# VAL-RESP-007: Disconnect, cancellation, and failure have stable outcomes

Surface: protocol and provider compatibility.
Needs: the response engine plus disposable real Omnigent with the deterministic
ACP agent.
Behavior: a client close after a committed function boundary does not cancel
anything, because the parked run is the point of the design. A close during
ordinary generation requests makes cancellation an engine-owned terminal
decision without waiting for a provider event; a completion already committed
still wins. An explicit cancel wins only before a terminal commit; a cancelled
chain refuses further continuation with
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
Evidence, real provider: `Open Responses through the gateway` in
`packages/gateway/test/omnigent-real.integration.test.ts` disconnects the HTTP
client from a busy chain while the deterministic ACP agent is deliberately
delayed. The persisted response becomes cancelled and the Omnigent session
stops running without the engine depending on an Omnigent terminal
cancellation event. The same suite kills the real isolated Omnigent server
while a chain is parked and observes
`interrupted`, no pending delivery, and a `backend_unavailable` continuation
rather than a hang.

## Current status

Passed on 2026-08-29, including HTTP disconnect cancellation and real Omnigent
server-process death against version 0.5.1.
