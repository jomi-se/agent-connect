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
reconstructs chain authority from the durable record alone, retrieves a
response that completed during the outage, and still redelivers an unresolved
published call.
Evidence: `packages/gateway/test/responses-durability.test.ts` reads the
on-disk chain file directly and asserts the persisted publication state,
provider token, grant id, and origin, then reconstructs completed and parked
chains with a second engine that shares no process memory;
`responses-route.test.ts` restarts a real gateway over the same state
directories and retrieves both outcomes over HTTP.
Fail: a call is published before it is durable, an output reaches the provider
before it is persisted, a restart loses an unresolved call, or a completed
response is unretrievable after an outage.
Scope: this is idempotent result submission, not a claim of exactly-once
application side effects. The harness snapshot never reports a parked call, so
the gateway's own ledger is the only source of truth for unresolved calls.

## Current status

Passed on 2026-08-28 for gateway restart. Crash-point tests that kill a live
gateway process at each commit boundary are not yet implemented.
