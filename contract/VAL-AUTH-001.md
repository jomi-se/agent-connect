# VAL-AUTH-001: Application grants create scoped session capabilities

Surface: api.
Needs: an active application grant bound to an exact browser Origin,
application id, scope set, and canonical tool snapshot.
Behavior: the grant creates or recovers an opaque logical session and returns
an expiring signed capability bound to origin, application id, logical session
id, and canonical tool-snapshot hash. Session traffic with a missing, expired, tampered,
cross-origin, cross-session, or tool-mismatched capability is rejected before
reaching Omnigent. A revoked grant invalidates its existing session capability.
Evidence: API tests covering valid grant use, expiration, tamper and binding
failures, tool-envelope enforcement, revocation, raw-provider rejection, and
zero provider calls for rejected traffic.
Fail: session creation succeeds without an active application grant; a bearer
can access a different application session; a revoked grant leaves its session
usable; or a caller can address a raw provider session.
Scope: application authorization and grant issuance are covered by
VAL-AUTHZ-001. Identity federation, DPoP, public-relay end-to-end encryption,
and durable provider-session recovery remain deferred.

## Current status

Passed automated gateway tests on 2026-07-22. The pre-release terminal pairing
and static raw-provider proxy paths have been removed, so the grant ceremony is
the only route to an application session.
