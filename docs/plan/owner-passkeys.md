# Owner passkeys instead of TOTP

Status: ready-for-human

Replace TOTP with passkeys, as the second factor after the passphrase for
sign-in and approvals. A passkey is bound to its domain, so each entry-point
address gets one; the first enrollment on an address is first-come, so
operators enroll right after exposing it. Recovery is a host-side
`reset-passkey`, like `reset-totp`. The owner pages' CSP needs a nonce for the
WebAuthn script.

[ADR 0019](../decisions/0019-owner-passkeys.md) proposes the policy and
implementation boundaries and waits for the owner to accept it. Migration
policy and library compatibility are unresolved.
