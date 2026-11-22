# ADR 0019: Owner passkeys

Status: Accepted (2026-11-19) 🙌

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

| Address enrolled with | Sign-in and approvals                                                 |
| --------------------- | --------------------------------------------------------------------- |
| a passkey             | the passkey alone, with user verification                             |
| TOTP                  | sign-in: the passphrase plus a TOTP code; each approval: a fresh code |
| nothing yet           | the passphrase, for enrolling a factor only                           |

1. **A passkey stands alone.** It already proves possession and user
   verification, and it is the part a phishing page cannot steal. Asking for
   the passphrase as well adds little, since the passphrase usually lives in
   the same password manager. Each approval needs a fresh passkey assertion.
2. **TOTP needs the passphrase too.** A six-digit code can be phished and
   proves nothing about the user, so it is only a second factor. Sign-in
   takes both; each approval in that signed-in session takes a fresh code.
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

   | Action                                                  | Owner console                                       | Host CLI                                |
   | ------------------------------------------------------- | --------------------------------------------------- | --------------------------------------- |
   | Remove an address's factor                              | yes, with a fresh assertion of the signed-in factor | yes, an exact address or explicit "all" |
   | Change the passphrase                                   | no, for now                                         | yes                                     |
   | Full reset: new passphrase, every address back to setup | no                                                  | yes                                     |

   Changing the passphrase keeps enrolled factors, since the passphrase only
   gates enrollment. It stays on the host, where the owner already types it at
   a terminal prompt; a console form can come later if it is missed. Host
   access is owner authority, so the CLI needs no factor. `remove-factor`
   replaces `reset-totp`: at a terminal it lists the stored factors to choose
   from, and an address or `--all` names the target directly; a full reset is
   `remove-factor --all` followed by `reset-passphrase`. Both terminal recovery
   commands revoke every app grant: recovery cannot know what leaked, and
   reconnecting an app is cheap (grants last 30 days at most).

8. **Start fresh.** The project is pre-1.0 and keeps nothing compatible. The
   new version does not read the old authorization state: the gateway refuses
   to start on it and says to run setup again, which replaces it. The owner
   sets the passphrase again and applications pair again.
9. **JavaScript is required for passkeys.** Inspecting, denying, revoking and
   navigating stay server-rendered forms. Passkey enrollment and use need
   WebAuthn; a browser without it gets a plain explanation, never a
   passphrase-only way past an enrolled passkey. Applications see no change:
   the script lives only in the gateway's own owner pages, and the OAuth flow
   and browser SDK are untouched. `PRODUCT.md`'s no-JavaScript rule changes
   to match when this ships.
10. **Sign-outs and app grants follow the factor.** When a sign-in factor goes,
    what it approved goes with it. Removing an address's factor on Security
    ends that address's owner sessions and revokes the app grants approved on
    that address, through the same path as Revoke and Revoke all so live
    sessions end within a second. Terminal recovery (`remove-factor` and
    `reset-passphrase`) revokes every app grant while the gateway is stopped;
    every owner session is also gone on restart, as today.
11. **One activity view.** The console lists pending requests from every
    address, each linking to the address it belongs to. The [surface model](../architecture/surface-model.md) sets out
    what belongs to one address and what the whole gateway shares.
12. **One cookie per address.** Two ports on the same host get different
    cookie names, so signing in on one does not replace the other's cookie.

## Protocol, state and CSP

The change stays inside owner authorization, the owner pages, host-side
recovery and their tests. Application OAuth/PKCE and the browser SDK do not
change.

Authorization state stores, per address: which factor it has, the passkey
credential or TOTP secret, its user handle and enrollment/reset metadata,
alongside the passphrase hash and grants. Records for an address removed from
configuration are kept, not erased; Security lists only configured addresses,
so a dropped address's record stays inert and reappears if the address returns
to configuration, while `agent-connect remove-factor <address>` in the terminal
still takes any stored address. Writes stay private and atomic, and fail
closed.

WebAuthn challenges are server-side, single-use and short-lived, bound to the
session, exact origin, purpose and current credential; an approval challenge
also binds the pending request. It does not bind the duration or profile picked
in the form: the passkey prompt cannot show them, so whoever could change them
could also change what the owner sees, and a taken-over owner page is lost
either way. The gain over today is the fresh tap itself: a stolen session
cookie cannot approve. A failed
check consumes the challenge. A restart invalidates unfinished ceremonies.
Enrollment re-checks at commit that the address is still unenrolled, and
replaces the setup session with a full owner session.

A small static script calls `navigator.credentials.create/get` and posts the
result as a same-origin form. Credentials and passphrases stay out of URLs,
browser storage and logs. The script is static, so a script-bearing page
allows it by its hash in the CSP header, as styles already are; the other CSP
rules (framing, no-store, the application callback) are unchanged.

## Library

`webauthn-rs` 0.6.2. Its passkey API keeps registration and authentication
state on the server, requires user verification and allows synced passkeys.
It uses pure-Rust crypto, with no OpenSSL; it builds static for the Linux musl
release targets, and its builder refuses IP literal origins. It does not tie a
credential to its address on the server side, so the gateway's per-address
storage is the guard. The spike is recorded in the
[plan](../plan/owner-passkeys.md).

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
[CSP hashes](https://www.w3.org/TR/CSP3/#external-hash),
[webauthn-rs 0.6.2](https://docs.rs/webauthn-rs/0.6.2/webauthn_rs/struct.Webauthn.html).
