# Owner passkeys

Status: in-progress

Each entry-point address gets one second factor, a passkey or TOTP, never
both. A passkey signs in and approves on its own; TOTP needs the passphrase
too; an address with neither can only enroll one. Passkey is the default, and
TOTP covers addresses that cannot have one (IP literals). Recovery is one
host-side reset per address. No migration: the gateway-wide TOTP enrollment is
dropped on upgrade. [ADR 0019](../decisions/0019-owner-passkeys.md), accepted
2026-11-19, holds the tables and the decisions.

## How it is checked

Every step is checked on a development machine, fast, without CI: Rust tests
with a real software passkey (real signatures, no mocks), local cross-builds,
and the owner pages in local Chromium with its virtual authenticator. CI
confirms on push; it is not the feedback loop. Real devices come once, at the
end.

## Steps

1. **Library spike.** Done: `webauthn-rs` 0.6.2 has no OpenSSL, builds static
   for both Linux musl targets with the release's Zig toolchain, refuses an IP
   literal origin in its builder, and its `SoftPasskey` completes a real
   registration and sign-in in-process. In local Chromium, the virtual
   authenticator registers and signs in from a script allowed by a per-response
   CSP nonce, while an un-nonced script on the same page is blocked; the whole
   run takes under two seconds. On `127.0.0.1` the browser refuses with
   `SecurityError: This is an invalid domain.`, so the gateway should know from
   the configured origin and render the explanation without trying.
2. **Map today's owner authentication** (sessions, TOTP state, how addresses
   are identified, CSP, tests) against the ADR, and list where they don't fit.
3. **Per-address state and the table's rules**, as Rust tests with
   `SoftPasskey`: one test per row of both tables, plus cross-address reuse,
   replay and concurrent enrollment.
4. **Enrollment and sign-in pages:** the small script (allowed by its hash in
   the CSP), the IP literal explanation with the TOTP option.
5. **Approvals** with a fresh passkey assertion.
6. **Console actions and the host reset command.** Security lists every
   address with its factor and a Remove button (fresh assertion of the
   signed-in factor; a TOTP session sees passkey rows without one). Removing
   signs that address out. `agent-connect remove-factor <address>|--all`
   replaces `reset-totp`; the passphrase changes on the host only, with
   `reset-passphrase`.
7. **Browser test** of the full flow in local Chromium with a virtual
   authenticator, CSP enforced (`npm run verify -- test:ui:owner`). The main
   address is `localhost`, with a passkey through Chromium's virtual
   authenticator; the same gateway by `127.0.0.1` takes the TOTP path, the
   IP-literal explanation and the sign-in recovery link through setup. The
   HTTPS cookie fixture sets up TOTP, since Chromium refuses WebAuthn on its
   untrusted test certificate.
8. **Docs:** `PRODUCT.md`'s owner-page rules, configuration, troubleshooting.
9. **Real devices**, by the owner: enroll and approve from a phone and from a
   desktop password manager, and read the IP literal page.
10. **macOS build**, last.

## Open

- **The library does not tie a credential to its address.** A passkey
  registered for one address verifies on another if the server hands it over
  and the authenticator signs (real authenticators don't; `SoftPasskey`
  does). Per-address storage is the guard, and it gets its own test.
  `SoftPasskey` is laxer than real authenticators, so the browser test stays.
- **`webauthn-rs` 0.6.2 depends on `rsa` 0.10.0-rc**, built in whether or not
  RS256 is accepted; its high-level API has no algorithm switch. RS256 is what
  older Windows Hello credentials use. Current lean: keep the library default.

## To review at the end

Calls made while building, small enough not to stop for, worth a second look
before release:

- **Removal challenge is not tied to the row.** One passkey challenge on the
  Security page covers every Remove button; the address is a form field
  under CSRF. Same reasoning as approvals: the prompt cannot show which row.
- **Security lists stored-but-unconfigured addresses too**, after the
  configured ones, so a factor whose address left the configuration can still
  be removed from the console.
- **No separate full-reset command.** `remove-factor --all` plus
  `reset-passphrase` is the full reset.
- **`remove-factor` normalizes the address it is given** (a trailing slash or
  path is dropped to the origin) and, when nothing matches, lists the
  addresses that have a factor.
- **Error and audit wording** now says "passphrase or passkey" where sign-in
  can fail either way.
- **Missing WebAuthn shows a sentence, not a page.** A browser without
  WebAuthn sees "This browser can't use passkeys" in the form's status line;
  no separate page, and the passkey form stays visible.
- **Passkey successes don't spend the factor attempt budget** (5 a minute
  per connection); failed assertions and every TOTP attempt still do. Found
  by the browser test: a sign-in and four approvals in a minute hit it.
- **Activity links each request to its own address** and says "on
  <address>" when it is not this one; the review happens there, under that
  address's factor.
- **Upgrade note lives in the changelog only.** The gateway's refusal message
  says to run setup again; the install guide says only that a release may ask
  for it.
