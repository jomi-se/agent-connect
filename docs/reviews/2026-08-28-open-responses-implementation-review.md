# Open Responses implementation review disposition

- Review date: 2026-08-28
- Target: the implemented version 0 Open Responses vertical slice
- Source: independent clean-context implementation review, followed by local
  reproduction and protocol checks
- Status: blockers and high-severity findings resolved or disproved; medium
  follow-ups explicitly classified below

## Verdict

The review found real silent-failure paths in persistence, cancellation,
provider liveness, and stream termination. Those findings were valid and are
fixed. The default switch is no longer blocked by the review's blocker/high
set, subject to the repository's existing compliance and final composition
gates.

One proposed blocker was rejected: a non-streaming response resource whose
`status` is `failed` is still returned as HTTP 200. The vendored Open Responses
contract defines `POST /responses` success as a `200` ResponseResource, and the
resource itself carries `status: "failed"` and `error`. Non-2xx responses are
reserved for failures that prevent producing the response resource, such as
invalid input, authorization, admission, or an unavailable backend before the
response begins. Changing this would make Agent Connect less compatible with
the chosen standard.

## Blockers and high-severity findings

| Finding                                                                          | Disposition | Result and evidence                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1: one file-store I/O error poisons all future writes and exposes phantom state | Fixed       | Writes are serialized without retaining a rejection as the queue tail. The in-memory index changes only after the durable rename and fsync path succeeds. A fault-injection regression proves a later write succeeds and the failed state was never readable. |
| B2: cancellation can be overwritten by a later tool call                         | Fixed       | Cancellation is now an engine-owned monotonic decision. A synchronous `cancelRequested` guard is checked before publication and terminalization; a non-terminal transition cannot resurrect the chain.                                                        |
| B3: non-streaming failed response uses HTTP 200                                  | Rejected    | This is the pinned Open Responses resource contract, not an HTTP routing failure. The failed status and error remain visible in the returned resource.                                                                                                        |
| B4: a dead run can redeliver a pending side effect                               | Fixed       | `pendingFunctionCalls` proves the retained run is alive before offering work. A dead chain is retired to `interrupted`, while its ledger entry remains available for diagnosis but not execution.                                                             |
| H1: capability refresh races response-session rehydration                        | Fixed       | `/v1/app-sessions` now awaits the same rehydration barrier as the other response-aware routes.                                                                                                                                                                |
| H2: tool-snapshot escape is laundered into `backend_unavailable`                 | Fixed       | Engine-generated `backend_protocol_error` survives the stream catch boundary. Snapshot escape is no longer reported as a network failure.                                                                                                                     |
| H3: provider stream EOF is treated as success                                    | Fixed       | EOF without an explicit terminal event produces a failed response with `backend_protocol_error`; partial text is not called a successful completion.                                                                                                          |
| H4: any first continuation event records `provider_observed`                     | Fixed       | Observation advances only on positive provider progress: text, another function call, or completion. Cancellation, failure, and EOF are not evidence of effect.                                                                                               |
| H5: busy cancellation can hang waiting for an Omnigent event                     | Fixed       | The engine terminalizes cancellation without requiring Omnigent to synthesize a terminal event. A deterministic ACP delay behind real Omnigent proves cancellation while the segment is busy and the SSE stream ends as cancelled.                            |
| H6: Omnigent event posts have no deadline                                        | Fixed       | Initial messages, outputs, and interrupts share a bounded request signal. A deliberate wedged-transport test proves the deadline; a failed initial prompt also closes the upstream pump.                                                                      |

The compatibility evidence for H5 is intentionally a real Omnigent
integration, not a fake-backend expectation. The in-process backend fixture no
longer invents a cancellation event.

## Medium findings

| Finding                                                         | Disposition                                                                                                                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1: corrupt chain files disappear silently                      | Fixed. Startup fails loudly with the corrupt path instead of turning durable state loss into a 404.                                                                                                                                                    |
| M2: whole-file rewrites and no retention/GC                     | Deferred. The version 0 one-chain files favor inspectability and atomicity. Successful-workspace expiry and cleanup remain operator work in `docs/plan/current-work.md`; optimize only with measured pressure.                                         |
| M3: prompt-post failure leaks the stream pump                   | Fixed. `open()` closes the run on initial-post failure.                                                                                                                                                                                                |
| M4: `parked` survives terminal provider states                  | Fixed. Cancel, failure, incomplete, and interruption clear the counter.                                                                                                                                                                                |
| M5: revoked-grant errors differ between route and engine layers | Deferred mapping cleanup. Both paths refuse access; unifying the public error taxonomy is useful but not a silent authorization bypass.                                                                                                                |
| M6: SSE writes ignore backpressure                              | Open before a high-volume/default production claim. The current bounded event queue prevents unlimited provider-side accumulation, but the HTTP writer still needs an explicit drain policy.                                                           |
| M7: unexpected post-header route errors can truncate SSE        | Open. Normal engine failures emit `error`, terminal resource, and `[DONE]`; an unexpected route-level throw after headers still needs a standards-consistent last-resort frame policy.                                                                 |
| M8: browser tool handlers have no deadline                      | Open product-policy choice. Cancellation is available, but a default/configurable handler deadline must be chosen with the application experience rather than guessed in the gateway review.                                                           |
| M9: malformed function argument JSON terminates the SDK task    | Open. Decide whether version 0 treats this as provider protocol failure or submits a structured tool error that permits model correction; test the chosen behavior through real Omnigent.                                                              |
| M10: recovery control routes have no automatic SDK consumer     | Open and required before claiming automatic browser recovery. The routes are usable and tested, but today expose diagnostics/manual recovery primitives rather than transparent reconnection.                                                          |
| M11: declared output maximum cannot fit its request envelope    | Fixed. The output limit is now 128 KiB, which remains reachable even under worst-case JSON escaping inside the 1 MiB request limit.                                                                                                                    |
| M12: a recorded successful output delivery can be posted again  | Fixed for `delivery_attempted`: the retained run is observed without reposting. The earlier `output_recorded` crash boundary remains explicitly at-least-once because a network acknowledgement cannot prove whether the provider applied the request. |
| M13: backend event queue is unbounded                           | Fixed. The queue has a finite capacity and fails the run explicitly on overflow.                                                                                                                                                                       |
| M14: rehydrated session metadata trusts the local chain store   | Accepted for the single-user local gateway threat model. Auth grant activity is rechecked; both files are gateway-owned local state under the same operator account. Revisit if the storage integrity domains or multi-tenant threat model change.     |

## Low findings

The conventional `model_not_found` status, independently computed timestamps,
response-orphan crash window, internal Origin spelling, and confusing
same-origin/no-`Origin` error remain cleanup candidates. None changes the
authorization, side-effect, persistence-before-publication, or cancellation
guarantees of the bounded slice. They should be handled only with a precise
contract and regression test, not bundled into the default switch for tidiness.

## Testing correction caused by this review

The review exposed a systemic test problem: the fake backend generated a
`cancelled` event that real Omnigent does not promise. That made two layers of
tests agree while the real busy-cancellation path could hang.

The permanent correction is documented in
[the testing strategy](../architecture/testing-strategy.md): Omnigent-sensitive
assertions use a disposable real Omnigent service and deterministic ACP agent.
Pure fixtures remain for Agent Connect-owned state machines and deliberate
fault injection, but are forbidden from serving as a compatibility oracle.

## Fresh verification

The corrected engine/durability/transport tests, gateway typecheck, and the
complete deterministic real-Omnigent integration suite passed on 2026-08-28.
The real-Omnigent cancellation scenario cancels a response while the ACP agent
is deliberately still busy, then observes a terminal cancelled public stream
without relying on a provider cancellation event.
