# VAL-JUDGE-003: Public enrollment and consent authorize only the fixed demo

Surface: browser and API.
Needs: VAL-JUDGE-001, a high-entropy judge enrollment passphrase delivered in
private testing instructions, and the exact deployed Firebase app/tool
snapshot.
Behavior: the `public-demo` profile performs connector-key proof, first-device
passphrase enrollment, connector-owned consent, PKCE exchange, and scoped grant
issuance for only the configured Firebase Origin, callback, app id, scopes, and
`set_page_message` snapshot. It neither requires nor fabricates a Tailscale
identity. Grant listing and revocation require the enrolled-device cookie.
Each device sees and revokes only grants approved by that device. Anonymous
passphrase failures are scoped to one pending authorization and cannot create a
persistent shared-principal lockout that rejects a correct passphrase on an
independent request. Verification concurrency is bounded; sustained anonymous
traffic remains an acknowledged transient-availability risk.
Evidence: API and clean-browser traces for success plus wrong Origin, redirect,
app id, tool hash, passphrase, missing device, replayed code, substituted
connector, spoofed Tailscale header, cross-device grant listing/revocation, two
independent clean-device enrollments, and revoked grant. Prove a nonconfigured
app/tool snapshot is rejected before consent and an otherwise valid grant fails
with a changed origin, app id, or snapshot. Verify the unchanged private profile
still rejects missing/unexpected Tailscale identities.

Fail: CORS/Origin alone authorizes a caller, a public visitor or another enrolled
device can list/revoke a judge's grants, one request's failures poison another
request, arbitrary app/tool authority can be consented, or `tailscale-serve`
behavior is weakened.
Scope: the shared judge passphrase authorizes evaluators to enroll; it does not
identify their civil identity.
