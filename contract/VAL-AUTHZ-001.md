# VAL-AUTHZ-001: Gateway-owned consent issues an exact PKCE application grant

Surface: API and browser.
Needs: VAL-ENROLL-001, one HTTPS app Origin, exact same-origin callback,
and an allowlisted Tailscale requester.
Behavior: a pushed request binds app id, Origin, callback, state, S256 challenge,
the required narrow scope set, and canonical tool metadata snapshot. A top-level gateway page enrolls the
device with the saved passphrase when necessary, displays declared authority, and
approves or denies. A short-lived single-use code exchanges only with the
matching verifier and bindings. Consent/revocation forms require gateway
same-origin requests. The legacy pairing exchange is unavailable.
Evidence: API/browser tests for success, denial, wrong redirect, wrong Origin,
CSRF, wrong passphrase, bad PKCE, replay, state substitution, incomplete scope
sets, changed tool metadata, and pairing bypass.
Fail: an app can self-approve, cross-site forms can approve/revoke, a redirect
is wildcarded, a code is replayable, missing scopes still authorize a session,
or pairing bypasses consent.
Scope: custom Agent Connect OAuth-style profile. General OAuth conformance,
app-instance keys, DPoP, RAR, discovery, and incremental consent are deferred.
The hash does not attest to the web application's handler implementation.

## Current status

Passed automated gateway and browser-library tests on 2026-07-14. Passed the
real Firebase-to-tailnet mobile enrollment, exact consent, PKCE return, tool
execution, grant revocation/rejection, reauthorization, and post-restart grant
reuse flow by 2026-07-17.
