# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Self-hosting developers who run their own Agent Connect gateway. They know what
a coding agent is and install the gateway themselves, but they should not need
ACP, MCP or harness vocabulary to approve an application.

The gateway usually runs on a headless remote machine (a VM reached over SSH),
though it can run anywhere the packaged binaries run. The owner therefore uses
the gateway's own web pages from another device: a laptop browser during setup,
and often a phone afterwards to approve an application or check what is
connected.

## Product Purpose

**Connect your AI.** Applications borrow an agent the user already owns. The
application supplies a fixed set of tools and its own UI; the owner's agent
supplies the intelligence, under scoped, revocable consent granted on pages the
owner's gateway serves.

The owner pages exist so the owner can, from any device: sign in, secure each
address with a passkey or an authenticator, approve or deny an application's
request, see
which applications hold access and which sessions are running, and end sessions
or revoke access. Success is a decision made quickly and correctly, with no
doubt about which application gets what.

## Positioning

The consent surface is served by the user's own gateway, not by the
application or a third-party identity provider. The owner approves an exact
application origin and a fixed list of tools, chooses how long access lasts
and under which restricted profile it runs, and can revoke it at any time.

## Operating Context

- First run: the owner installs the gateway on a remote machine, runs
  `agent-connect setup` and `agent-connect login` over SSH, then opens the owner
  pages in a browser through a configured entry point (tailnet or public HTTPS
  origin). The passphrase there opens setup only, where the owner creates a
  passkey for that address (or an authenticator app where a passkey cannot
  work).
- Recurring: an application the owner is using redirects to the gateway's
  consent page; the owner reviews and approves or denies, then returns to the
  application. This often happens on a phone, mid-task.
- Occasional: reviewing active grants and live sessions, ending a session,
  revoking one or all grants, signing out of a shared browser.
- Recovery from a lost passkey or authenticator is a host-side command
  (`agent-connect remove-factor`), not a web flow.

## Capabilities and Constraints

- Pages are server-rendered HTML from the Rust gateway
  (`crates/gateway/src/authorization.rs`) with a strict Content Security Policy:
  inline styles and scripts are hash-pinned. Every flow other than using a
  passkey works as plain forms and links.
- Each entry-point address has one second factor
  ([ADR 0019](docs/decisions/0019-owner-passkeys.md)): a passkey, which alone
  signs in and approves, or TOTP, which needs the passphrase to sign in and a
  fresh code for each approval. An address with neither can only enroll one.
- Consent shows the exact application origin, the fixed tools with their exact
  input schemas, access duration and restricted profile. These facts must stay
  inspectable; how prominently they are shown is a design decision.
- Required honest disclosures: grants share a dedicated harness home (a
  consented application may obtain that login and read other applications'
  transcripts); revocation and expiry cannot undo completed effects; ACP and
  MCP-over-ACP are unstable.
- Owner pages are served only on the configured entry-point origins; approvals
  are bound to the origin used.

## Brand Commitments

- Name: Agent Connect.
- The three-dot mark (orange, teal, purple) and the current teal-led palette are
  binding. Layout, typography, components, copy and flows may change.
- Voice: plain and brief. Remove excessive labels and explanatory text; say a
  thing once, where it is needed.

## Evidence on Hand

- Browser qualification of all owner-page states at desktop, phone and reflow
  widths: `npm run test:ui:owner` (`scripts/owner-ui.mjs`).
- A real-device owner test of a real application (approval and use from a
  phone) succeeded. No testimonials, user counts or benchmarks exist; do not
  invent any.

## Product Principles

1. The decision comes first: what is being asked, by which exact application,
   and the one action to take.
2. Exactness stays one tap away: origins, tools and schemas are never hidden
   behind vague summaries, but full detail is disclosed on demand.
3. Secure setup is a guided path, not a buried setting.
4. Work equally well on a phone over a remote link and on a laptop.
5. Every page works without JavaScript, except that a passkey needs it:
   creating one and using it to sign in or approve. Without WebAuthn the page
   says so plainly and never offers a passphrase-only way past a passkey.
   Inspecting, denying, revoking and navigating stay plain forms. Other small
   hash-pinned enhancements are allowed where they remove real friction
   (copying the authenticator setup key); the page must still work when they
   do not run.

## Accessibility & Inclusion

The existing qualification requires keyboard order, visible 3px focus outlines,
44px touch targets on small viewports and 320px reflow. Keep or exceed these.
