# VAL-RESP-005: Authorization fails closed on every response operation

Surface: api, security.
Needs: the gateway authorization ceremony and an approved tool snapshot.
Behavior: a wrong Origin, a missing or mismatched session capability, a model
other than `agent-connect/default`, tools that differ from the approved
snapshot, a response chain belonging to another application session, or a
call ID that is not the chain's unresolved call each fail closed with the
pinned error code. Canonical tool projection is compared after
canonicalization, so property order does not change the hash while a changed
description, an added tool, or `strict: false` does. An originless caller is a
non-browser client: it is admitted only on the response routes, only with a
transport principal, and only when the grant carries the explicit
`non_browser_clients` consent bit, which defaults to off.
Evidence: `packages/gateway/test/responses-route.test.ts` covers the origin,
capability, snapshot, cross-session, and both non-browser ingress outcomes;
`responses-engine.test.ts` covers call ID, chain ownership, and grant
revocation across create, continue, retrieve, and cancel;
`tool-snapshot.test.ts` covers hash stability under property order.
Fail: any of the above succeeds, a revoked grant continues a chain, or an
originless caller reaches the gateway without explicit consent on the grant.
Scope: the Origin check is strong against browsers and worthless against
non-browser callers; what the consent bit preserves is the user's decision, not
a transport-level defence. See ADR 0009.

## Current status

Passed on 2026-08-28.
