# ADR 0019: Owner passkeys

Status: Proposed (2026-10-28)

## Context

Owner authentication currently combines a passphrase with an optional, globally enrolled TOTP factor. Owner sessions and application approvals already bind to an exact configured entry-point origin. Offline recovery preserves the passphrase and application grants under an exclusive authorization-state lock.

The accepted backlog direction is to replace TOTP with passkeys as a second factor after the passphrase for sign-in and approvals, permit one credential per entry-point address, use first-come enrollment, provide host-side `reset-passkey`, and authorize the WebAuthn script with a CSP nonce. This ADR proposes the remaining policy and implementation boundaries; its defaults are not yet accepted.

Configured HTTPS addresses and HTTP loopback addresses, including IP literals, are supported product behavior. Selecting a library does not authorize removing those capabilities.

## Proposed decisions requiring owner acceptance

1. **Preserve protection during migration.** Active version-1 TOTP state must never become passphrase-only authority through an ordinary upgrade. Refuse startup without modifying that state until an explicit offline migration authorizes removal of the old factor and subsequent passkey enrollment. Preserve password hashes and grants. State without an enrolled factor may convert under the existing lock. The precise migration command remains to be settled; no online TOTP compatibility flow or `reset-totp` alias remains afterward.

2. **Restrict unenrolled addresses to setup.** A correct passphrase creates an enrollment-only session until that address has a passkey. It cannot approve applications or acquire full owner authority. Existing application grants remain valid. First-come means the first successful, durably committed registration by someone who knows the passphrase, not the first anonymous request. This tightens today's optional-factor behavior and requires explicit acceptance; retaining passphrase-only approvals is the alternative.

3. **Require fresh proof for approvals.** Recommend a fresh passphrase followed by a passkey assertion for each approval. Today approvals rely on the existing passphrase-authenticated session plus fresh TOTP. Retaining that session-based first factor is an explicit alternative. Denial continues to require valid owner-session/CSRF checks but no fresh factor.

4. **Separate address records from RP identity.** Index credentials by full canonical configured origin, including port. Use the exact hostname as RP ID, separate random user handles per address, and exact-origin verification. Do not share credentials automatically across entry points or enable parent-domain, wildcard, or Related Origins policies. WebAuthn RP IDs omit scheme/port, while discoverable credentials associate RP ID and user handle; these are distinct from application origin boundaries. [WebAuthn specification](https://www.w3.org/TR/webauthn-3/).

5. **Make recovery scope explicit.** `reset-passkey` requires an exact entry-point selector or explicit all-addresses selection. It preserves passphrase and grants and returns affected addresses to setup. Enrollment invalidates other sessions and challenges for that address while preserving verified sessions on other addresses; global invalidation remains an alternative. Rotate the completing session.

6. **Make the browser requirement honest.** Update the product's plain-forms requirement: inspection, denial, revocation and navigation remain server-rendered; passkey enrollment and verification require JavaScript/WebAuthn. Unsupported browsers and disabled JavaScript receive useful explanations, never a passphrase-only bypass for an enrolled credential.

7. **Decide the owner-origin migration explicitly.** WebAuthn registration and authentication require a domain-form caller origin; IPv4 and IPv6 literals fail before RP-ID selection. `http://localhost:<port>` with RP ID `localhost` is the ordinary local path; HTTPS on a literal IP does not solve the restriction. Replacing the server library cannot preserve direct IP-origin passkey authentication. Decide the supported owner authentication origin and migration before implementation; do not silently remove existing entry points, transfer sessions across origins or downgrade them to passphrase-only authority. [WebAuthn origin checks](https://www.w3.org/TR/webauthn-3/), [Chromium supported origins](https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/webauth/origins.md).

## Protocol, state and CSP boundary

Keep the change inside gateway owner authorization, owner pages, offline recovery and their tests. Application OAuth/PKCE contracts and the browser SDK remain unchanged.

Version-2 authorization state stores bounded per-origin credential records, stable opaque user handles, enrollment/reset metadata, and the existing passphrase/grants. Preserve inactive records when an address is removed from configuration; do not silently erase security state. Maintain private atomic writes and fail closed if persistence fails.

Registration and authentication challenges remain bounded, expiring, server-side state. Bind each to the initiating session, exact origin, purpose and current credential. Login carries only a validated pending continuation. Approval also binds the pending request and selected duration/profile. Correct passphrase validation issues a challenge, not authenticated authority. Completion verifies a single-use challenge, current request/session/credential state and exact origin before committing success. Failed verification consumes the matched challenge; mismatched sessions cannot consume another session's record. Restart invalidates unfinished ceremonies. Concurrent registration rechecks that the address remains unenrolled at commit.

Use a small static script for `navigator.credentials.create/get`, encoding the response into a bounded same-origin form submission. Keep credentials and passphrases out of URLs, persistent browser storage and diagnostics. Retain explicit user initiation, cancellation and fresh-retry paths; never replay an uncertain approval.

Generate a fresh cryptographic nonce for each script-bearing response and share it between the CSP header and script element. Preserve hashed styles, framing restrictions, no-store and the narrowly allowed application callback. The consent page's CSP override must preserve script authorization. Avoid executable interpolation of options and unnecessary network-policy expansion. CSP requires unique, unpredictable nonces and recommends at least 128 bits. [CSP nonce requirements](https://www.w3.org/TR/CSP3/#security-nonces).

## Candidate library and unresolved compatibility

`webauthn-rs` 0.5.5 is a candidate, not a selection. Its high-level passkey methods separate browser options from server-held registration/authentication state; persisted credentials support updates after authentication. Prefer these APIs over custom signature verification or low-level internals. [Versioned API](https://docs.rs/webauthn-rs/0.5.5/webauthn_rs/struct.Webauthn.html), [credential updates](https://docs.rs/webauthn-rs/0.5.5/webauthn_rs/prelude/struct.Passkey.html).

Its passkey flow requires user verification and permits synchronized authenticators. Exact-origin/port checks are available; its builder's domain validation excludes IP-literal origins, consistent with the browser restriction above. Owner-origin migration is a product decision rather than a library substitution. [Versioned source](https://docs.rs/crate/webauthn-rs/0.5.5/source/src/lib.rs).

Its core also depends on OpenSSL; upstream requires OpenSSL 3. Every supported release artifact must retain its installation/runtime contract, rather than acquiring an undeclared native dependency. Cross-target build/linking qualification is mandatory. [Versioned manifest](https://docs.rs/crate/webauthn-rs-core/0.5.5/source/Cargo.toml), [upstream requirements](https://github.com/kanidm/webauthn-rs/blob/master/OpenSSL.md). Physical-device and mobile credential-provider behavior also remains unqualified.

## Implementation qualification

Verify genuine registration/assertion processing; exact-origin and cross-port isolation; session, purpose, CSRF and expiry binding; replay rejection; concurrent enrollment; invalid signatures/user verification; cancellation; unchanged approval selections; denial; and persistence failure without new authority. Prove active-TOTP migration fails closed and offline recovery preserves grants/passphrase.

Exercise actual gateway pages in Chromium with a virtual WebAuthn authenticator, including CSP enforcement and complete login/approval flows. Separately qualify supported real-device browser paths and the accepted migration for IP-literal entry points; virtual success does not establish physical-device compatibility. [Chromium WebAuthn protocol](https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/).

Resolve the owner choices and candidate-library compatibility before accepting this ADR. The implementation then needs the evidence above; accepting a design does not establish browser or release qualification.
