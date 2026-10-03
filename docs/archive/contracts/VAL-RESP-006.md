# VAL-RESP-006: A published call is durable before it is published

Surface: data, protocol.
Needs: the file-backed response store.
Behavior: an application function call reaches durable storage in the
`recorded` publication state before its SSE event is written, and a function
output is persisted before the provider is contacted. Call state advances on
three orthogonal axes, so "output persisted but not yet posted" is
representable; a provider acknowledgement is not treated as proof of effect,
and the result becomes `provider_observed` only when the provider emits
something afterwards. A same-output retry returns the existing record and may
redrive delivery; a different output conflicts. A restarted gateway
reconstructs chain authority from the durable record alone and retrieves a
response that completed during the outage. An unresolved published call is
redelivered only while its original run remains alive; if the run is gone, the
ledger retains the call for diagnosis but never asks the application to perform
a side effect whose result cannot be accepted. A corrupt chain file is
quarantined with an operator-visible path while healthy chains still load.
Evidence: `packages/gateway/test/responses-durability.test.ts` reads the
on-disk chain file directly and asserts the persisted publication state,
provider token, grant id, and origin, then reconstructs completed and parked
chains with a second engine that shares no process memory;
`responses-route.test.ts` restarts a real gateway over the same state
directories and retrieves both outcomes over HTTP;
`responses-process-crash.integration.test.ts` spawns and SIGKILLs an actual
gateway child at all four commit boundaries, restarts over the same files, and
asserts the durable call state, provider-side observation ledger, terminal
reconstruction, empty delivery set, valid JSON, and absence of temporary files.
Fail: a call is published before it is durable, an output reaches the provider
before it is persisted, a dead run redelivers an unresolved call, one corrupt
chain prevents healthy gateway state from loading, or a completed response is
unretrievable after an outage.
Scope: this is idempotent result submission, not a claim of exactly-once
application side effects. The harness snapshot never reports a parked call, so
the gateway's own ledger is the only source of truth for unresolved calls.

## Current status

Passed on 2026-08-28 for gateway restart and four real-process crash points.
Run the latter with `npm run test:integration:response-crash`.
