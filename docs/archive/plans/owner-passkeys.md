# Owner passkeys

Status: done

Each entry-point address gets one second factor, a passkey or TOTP, never
both. A passkey signs in and approves on its own; TOTP needs the passphrase
too; an address with neither can only enroll one. Passkey is the default, and
TOTP covers addresses that cannot have one (IP literals). Recovery is one
host-side reset per address. No migration: the gateway-wide TOTP enrollment is
dropped on upgrade. [ADR 0019](../../decisions/0019-owner-passkeys.md), accepted
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
   configured address with its factor and a Remove button (fresh assertion of
   the signed-in factor; a TOTP session sees passkey rows without one).
   Removing signs that address out and revokes app grants approved on that
   address (ending live sessions within a second).
   `agent-connect remove-factor` (a picker at a terminal, or an address or
   `--all`) replaces `reset-totp`; the
   passphrase changes on the host only, with `reset-passphrase`. Both terminal
   recovery commands revoke every app grant.
7. **Browser test** of the full flow in local Chromium with a virtual
   authenticator, CSP enforced (`npm run verify -- test:ui:owner`). The main
   address is `localhost`, with a passkey through Chromium's virtual
   authenticator; the same gateway by `127.0.0.1` takes the TOTP path, the
   IP-literal explanation and the sign-in recovery link through setup. The
   HTTPS cookie fixture sets up TOTP, since Chromium refuses WebAuthn on its
   untrusted test certificate.
8. **Docs:** `PRODUCT.md`'s owner-page rules, configuration, troubleshooting.
9. **Real devices**, by the owner: enroll and approve from a phone and from a
   desktop password manager, and read the IP literal page. Done 2026-11-24.
   It found three bugs, all fixed: enrollment asked for a non-discoverable
   credential, which Chrome on Android kept on the device instead of offering
   it to the password manager; a password manager extension's `toJSON()` left
   the response's bytes unencoded, so the pages now encode it themselves; and
   an expired sign-in page said "Signed out". The code field became six boxes.
10. **macOS build**: the release workflow's build, green in CI. There is no
    macOS machine to test on by hand. Done 2026-11-25: the release workflow
    built every target and published gateway 0.0.7 with browser SDK 0.0.11.

## Open

- **The library does not tie a credential to its address.** A passkey
  registered for one address verifies on another if the server hands it over
  and the authenticator signs (real authenticators don't; `SoftPasskey`
  does). Per-address storage is the guard, and it gets its own test.
  `SoftPasskey` is laxer than real authenticators, so the browser test stays.

## To review at the end

Calls made while building, small enough not to stop for, worth a second look
before release:

### Settled

- **`webauthn-rs` 0.6.2 brings in `rsa` 0.10.0-rc, and it stays.** Its
  `crypto-glue` dependency is on the current RustCrypto generation (`digest`
  0.11, `signature` 3), and `rsa`'s release for that generation is still a
  release candidate; no advisory drove it. RUSTSEC-2023-0071 (Marvin) is
  unfixed in 0.9 and 0.10 alike and concerns private-key operations; the
  gateway only verifies RS256 signatures, which older Windows Hello passkeys
  use. The final 0.10.0 already satisfies the library's requirement.
- **The upgrade note lives in the changelog.** In 0.0.7 it said what the
  gateway's refusal said: remove the old owner state and run setup again.
  Upgrading the first real gateway showed that setup and `doctor` let the old
  state through and only `serve` refused it, so the service crash-looped. Setup
  now names the file and offers to replace it (`[y/N]`), and `doctor` fails
  for it (after 0.0.7). Every release now upgrades from the previous one
  before its bump ([release process](../../install/release.md#upgrade-from-the-last-release)).
- **Activity links each request to its own address.** Kept, and written up
  as the [surface model](../../architecture/surface-model.md): to an application each address is its own gateway, so a
  request is reviewed at the address it came through; to the owner the
  console is one gateway and shows every address.
- **Rate limits and guess limits are separate.** Rate limits catch runaway or
  hostile traffic and count every request (600 a minute without an owner
  session, a per-source limit with client address rules, a concurrency cap).
  Guess limits count only wrong guesses: 10 wrong passphrases per 15 minutes,
  5 wrong passkeys or codes a minute, per connection. A success never counts
  and never clears earlier wrong guesses, so an owner approving several apps
  in a minute is fine and nothing is handed back afterwards.
- **A browser without passkeys hears so when it tries.** The passkey
  sign-in page is a heading and one button. Pressing it where the browser has
  no WebAuthn says "This browser can't use passkeys." and posts nothing; any
  other failure says the passkey didn't go through. It is the visitor's own
  browser, so the sentence tells an attacker nothing.
- **A failed sign-in says only "Sign-in failed".** A wrong passphrase, passkey
  or authenticator code, and a paused code budget, all get the same 401 page:
  the code is checked after the passphrase, so a separate answer for it would
  confirm the passphrase. The owner's sign-in history and the journal keep the
  real reason (`invalid_passphrase`, `invalid_passkey`, `invalid_factor`,
  `factor_rate_limited`). Approvals, already signed in, still name the code.
- **Remove asks for a fresh passkey tap, but the tap doesn't say which
  address.** Kept: one passkey challenge on the Security page covers every
  Remove button, with the address in a form field under CSRF. Same reasoning as
  approvals: the prompt cannot show which row.
- **Security lists only configured addresses.** A factor whose address has left
  the configuration is inert, so the console does not need to surface it; the
  stored record stays on disk and reappears if the address returns to
  configuration, and `agent-connect remove-factor <address>` in the terminal
  still takes any stored address.
- **No separate full-reset command, and when a sign-in factor goes, what it
  approved goes with it.** `remove-factor --all` plus `reset-passphrase` stays
  the full reset. Removing a factor on Security revokes app grants approved on
  that address (ending live sessions within a second), and both terminal
  recovery commands (`remove-factor` and `reset-passphrase`) revoke every app
  grant: recovery cannot know what leaked, and reconnecting an app is cheap
  (grants last 30 days at most).

- **`remove-factor` is a picker at a terminal.** It lists each stored
  passkey and authenticator (marking addresses no longer configured) with
  arrow keys and a fuzzy filter, then confirms with what goes and how many
  apps will need to connect again. A named address skips the list after
  dropping any path or trailing slash; one with no factor opens the list. With
  `--yes`, an address or `--all` is required and nothing prompts.

### Still to review

Nothing. The design pass is done: every owner page, the error pages and the
terminal messages now use labels, with explanation kept for a decision that
can't be taken back and for an uncommon dead end. The approval page's risk
sentence reads "An approved app can use your agent's login and see other
apps' conversations." until [per-app conversations](../../plan/app-conversations.md)
land. The recovery commands stop and start a running user service themselves.

## Released

Gateway 0.0.7, 2026-11-25. The first real gateway was upgraded the same night:
a passkey on a phone and in a desktop password manager, and an app paired and
used through it. That upgrade also left a dead egress behind its crash loop
([issue](../../issues/failed-service-start-leaves-dead-egress.md)), which is
not passkey work.
