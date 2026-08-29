# VAL-RESP-008: Open Responses is the sole browser task wire

Surface: browser SDK, gateway HTTP API, and Canvas demo.

Needs: VAL-RESP-001 through VAL-RESP-007.

Behavior: `connectAgent()` always creates response segments through
`POST /v1/responses`; its neutral `runTask()` and `streamTask()` conveniences
chain approved application function calls through `previous_response_id`.
The Canvas uses this path without a query flag. The gateway returns 404 for the
removed browser-visible `/v1/sessions/:id/stream` and `/events` routes. Omnigent
remains internal to the bundled backend.

Evidence: SDK tests assert the exact first and continuation requests and the
absence of `/v1/sessions` requests; gateway tests assert raw provider/session
routes are unavailable; `npm run verify:full` includes process-crash recovery,
the pinned real-Omnigent compatibility suite, package installation, and Canvas
browser coverage; a final private browser-to-Codex composition exercises at
least two browser-owned functions and returns final text.

Fail: an application can select the legacy wire, the package exports a
browser-visible Omnigent provider, the gateway proxies the removed routes, the
Canvas needs `?protocol=open-responses`, provider identifiers reach the page,
or the final real composition fails.

Scope: the SDK's provider-neutral task events are a local convenience API, not
a second HTTP protocol. Authorization, application-session bootstrap,
recovery, and cancellation remain Agent Connect control operations outside
the standard Responses endpoint.
