# VAL-JUDGE-003: Public enrollment and consent authorize only the fixed demo

Surface: browser and API.
Needs: VAL-JUDGE-001, a high-entropy judge enrollment passphrase delivered in
private testing instructions, and the exact deployed Firebase app/tool
snapshot.
Behavior: the `public-demo` profile performs gateway-key proof, first-device
passphrase enrollment, gateway-owned consent, PKCE exchange, and scoped grant
issuance for only the configured Firebase Origin, callback, app id, scopes, and
current ten-tool Canvas snapshot. It neither requires nor fabricates a Tailscale
identity. Grant listing and revocation require the enrolled-device cookie.
Evidence: API and clean-browser traces for success plus wrong Origin, wrong app
id/tool snapshot, wrong passphrase, missing grant-device cookie, replayed code,
and revoked grant. Prove a nonconfigured app/tool snapshot is rejected before
consent. Verify the unchanged private profile still rejects missing or
unexpected Tailscale identities. Run public browser evidence in a clean profile
because the private and public endpoints currently share a cookie hostname.

Fail: CORS/Origin alone authorizes grant management, a visitor without an
enrolled-device credential can list or revoke grants, arbitrary app/tool
authority can be consented, or `tailscale-serve` behavior is weakened.
Scope: the shared judge passphrase authorizes evaluators to enroll; it does not
identify their civil identity. The profile remains a narrow shared evaluation
environment rather than a general anonymous gateway.
