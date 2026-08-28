# VAL-ENROLL-001: Enrolled gateway proves identity before tool disclosure

Surface: public library and API.
Needs: a first-run gateway state path, exact public endpoint, allowlisted
Tailscale requester, and public runtime card imported by the browser app.
Behavior: an explicit one-shot initializer creates a durable Ed25519 identity
and high-entropy enrollment passphrase, stores only an scrypt verifier, and
emits the bundle once. Normal serving refuses uninitialized state and never
accepts the plaintext passphrase through deployment configuration. For every
new application authorization, the SDK verifies a signature
over a fresh nonce, runtime id, and endpoint using the pinned card before it
sends tool schemas.
Evidence: API/library tests proving state reload, valid challenge, invalid
signature and substituted runtime rejection, and zero authorization/tool-schema
request after failed proof.
Fail: the state file contains the passphrase, an app-origin page receives the
passphrase, tools are sent before gateway proof, or a restarted gateway
changes identity unexpectedly.
Scope: direct operator-channel enrollment proves continuity with the selected
gateway, not host integrity or civil identity. Recovery and key rotation are
deferred.

## Current status

Passed automated gateway and browser-library tests on 2026-07-14. Passed the
deployed mobile/runtime-card flow on 2026-07-17, including a controlled gateway
restart with unchanged runtime id, gateway public key, state-file digest,
enrolled device, and grant records.
