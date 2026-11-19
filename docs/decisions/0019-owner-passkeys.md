# ADR 0019: Owner passkeys

Status: Proposed (rewritten 2026-11-19)

## Context

The owner signs in to the gateway's owner pages and approves applications
there. Today that takes the passphrase plus an optional TOTP code, enrolled
once for the whole gateway. Owner sessions and approvals already bind to the
exact entry-point origin they were made on.

A passkey is stronger than a TOTP code: a phishing page cannot capture it, and
with user verification it needs both the device and the owner's biometric or
PIN. But a passkey is bound to a domain, and browsers refuse WebAuthn on IP
literal origins, so it cannot cover every entry point the gateway supports.

## Decision

Each entry-point address has **one second factor: a passkey or TOTP, never
both.** What an address accepts follows from which one it has:

| Address enrolled with | Sign-in and approvals |
|---|---|
| a passkey | the passkey alone, with user verification |
| TOTP | the passphrase plus a TOTP code |
| nothing yet | the passphrase, for enrolling a factor only |

1. **A passkey stands alone.** It already proves possession and user
   verification, and it is the part a phishing page cannot steal. Asking for
   the passphrase as well adds little, since the passphrase usually lives in
   the same password manager. Each approval needs a fresh passkey assertion.
2. **TOTP needs the passphrase too.** A six-digit code can be phished and
   proves nothing about the user, so it is only a second factor.
3. **An unenrolled address can only enroll.** The passphrase alone opens a
   setup session that can enroll a passkey or TOTP for that address and do
   nothing else: no approvals, no owner authority. Enrollment is first-come
   among people who know the passphrase; operators enroll right after exposing
   an address. Existing application grants stay valid.
4. **Passkey is the default; TOTP is for addresses that cannot have one.**
   Setup offers a passkey first. TOTP is offered where a passkey cannot work
   (an IP literal origin) or when the owner chooses it.
   On an IP literal address, the setup page says plainly why there is no
   passkey (browsers allow passkeys only on a domain name) and how to get
   one: open the gateway by a name instead, such as `localhost` on the same
   machine, the tailnet's DNS name, or a domain or tunnel the operator
   controls. The exact wording and links are settled with the page.
5. **No downgrade.** Once an address has a passkey, TOTP is not accepted there.
   Removing a factor puts its address back to setup. A session signed in with
   TOTP can manage TOTP addresses only, never remove a passkey.
6. **Factors are per address.** Credentials are indexed by the full configured
   origin, port included. A passkey's RP ID is the exact hostname, with its
   own random user handle per address; no sharing across entry points, no
   parent-domain, wildcard or Related Origins policy. Enrolling a new address
   takes only the passphrase, never another address's passkey: a passkey
   protects its own address, not other names that reach the same gateway.
   Entry points are not otherwise told apart; a tailnet name and a public
   tunnel get the same treatment.
7. **Everyday changes in the console, lockout recovery on the host.**

   | Action | Owner console | Host CLI |
   |---|---|---|
   | Remove an address's factor | yes, with a fresh assertion of the signed-in factor | yes, an exact address or explicit "all" |
   | Change the passphrase | yes, the old passphrase plus a fresh assertion | yes |
   | Full reset: new passphrase, every address back to setup | no | yes |

   Changing the passphrase keeps enrolled factors, since the passphrase only
   gates enrollment. Grants survive all of these. Host access is owner
   authority, so the CLI needs no factor; one reset command replaces
   `reset-totp`.
8. **No migration.** The project is pre-1.0 and keeps nothing compatible. The
   gateway-wide TOTP enrollment is dropped on upgrade; every address starts
   unenrolled, which by decision 3 means setup only, so nothing gains
   authority. Owner sessions are invalidated.
9. **JavaScript is required for passkeys.** Inspecting, denying, revoking and
   navigating stay server-rendered forms. Passkey enrollment and use need
   WebAuthn; a browser without it gets a plain explanation, never a
   passphrase-only way past an enrolled passkey. Applications see no change:
   the script lives only in the gateway's own owner pages, and the OAuth flow
   and browser SDK are untouched. `PRODUCT.md`'s no-JavaScript rule changes
   to match when this ships.

## Protocol, state and CSP

The change stays inside owner authorization, the owner pages, host-side
recovery and their tests. Application OAuth/PKCE and the browser SDK do not
change.

Authorization state stores, per address: which factor it has, the passkey
credential or TOTP secret, its user handle and enrollment/reset metadata,
alongside the passphrase hash and grants. Records for an address removed from
configuration are kept, not erased. Writes stay private and atomic, and fail
closed.

WebAuthn challenges are server-side, single-use and short-lived, bound to the
session, exact origin, purpose and current credential; an approval challenge
also binds the pending request and the selected duration and profile. A failed
check consumes the challenge. A restart invalidates unfinished ceremonies.
Enrollment re-checks at commit that the address is still unenrolled, and
replaces the setup session with a full owner session.

A small static script calls `navigator.credentials.create/get` and posts the
result as a same-origin form. Credentials and passphrases stay out of URLs,
browser storage and logs. A script-bearing page gets a fresh nonce of at least
128 bits, shared by its CSP header and script element; the other CSP rules
(hashed styles, framing, no-store, the application callback) are unchanged.

## Library

`webauthn-rs` 0.5.5 is the candidate. Its passkey API keeps registration and
authentication state on the server, requires user verification and allows
synced passkeys. Its core needs OpenSSL 3, so before any feature work, every
release target must build and link it within its existing install contract.
If that fails, pick another library before writing the feature.

## Qualification

Tests cover real registration and assertion, exact-origin and cross-port
isolation, session/purpose/CSRF/expiry binding, replay, concurrent enrollment,
bad signatures and missing user verification, cancellation, the no-downgrade
rule, the TOTP path, and persistence failure. The owner pages are exercised in
Chromium with a virtual authenticator, CSP enforced, through full sign-in and
approval. Real devices and mobile credential providers are qualified
separately; a virtual authenticator proves the protocol, not the devices.

References: [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/),
[Chromium WebAuthn origins](https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/webauth/origins.md),
[CSP nonces](https://www.w3.org/TR/CSP3/#security-nonces),
[webauthn-rs 0.5.5](https://docs.rs/webauthn-rs/0.5.5/webauthn_rs/struct.Webauthn.html).
