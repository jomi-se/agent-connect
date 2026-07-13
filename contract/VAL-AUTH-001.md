# VAL-AUTH-001: Private-channel pairing grants a scoped application capability

Surface: api.
Needs: an exact allowed browser Origin and a pairing code emitted through the
connector's local terminal.
Behavior: the code can be exchanged exactly once for an expiring signed
capability bound to origin, application id, logical session id, and canonical
tool-snapshot hash. Session traffic with a missing, expired, tampered,
cross-origin, cross-session, or tool-mismatched capability is rejected before
reaching OmniGENT. Consuming a code rotates a new code without restarting the
gateway.
Evidence: API tests covering valid exchange and all negative bindings, rotation,
tool-envelope enforcement, and zero upstream calls for rejected traffic.
Fail: CORS or a caller-supplied identity claim is treated as user proof, a
pairing code remains reusable, a hosted bundle contains the code, or a bearer
can access a different application session.
Scope: this proves possession-based pairing for a single-user connector. Device
public keys, durable revocation, identity federation, and public-relay security
are deferred.

## Current status

The in-process possession boundary passes automated API coverage: one-use code
rotation, signed capability issuance, expiration, tamper rejection,
cross-origin rejection, session binding, changed-snapshot rejection, and
pre-upstream tool-envelope enforcement. Production identity, durable device
keys, revocation, and relay security remain explicitly unproven.
