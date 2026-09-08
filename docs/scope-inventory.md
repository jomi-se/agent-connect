# Scope and capability inventory

Updated: 2026-09-08

This inventory describes the supported stock OpenClaw scoped proxy.
[ADR 0014](decisions/0014-stock-openclaw-scoped-proxy.md) is authoritative.
The parent native-patch and earlier replacement engines remain preserved
experiments, not prerequisites or evidence for this path. A private scoped-proxy
deployment and live composition evidence exist. The owner accepted the prototype
for main with known search/navigation defects; the [closeout ledger](plan/stock-openclaw-vertical-closeout.md)
retains the unconfirmed fine-grained phone checks rather than claiming all passed.

## Application and SDK

| Capability                                  | Status                      | Current boundary                                                                                       |
| ------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Define typed application tools              | Implemented, unchanged      | Browser-safe definitions; exact owner-approved snapshot on every segment                               |
| Discover and authorize a gateway            | Implemented, unchanged      | OAuth discovery, PAR, S256 PKCE, consent, rotating refresh and revocation                              |
| Establish owner identity                    | Implemented                 | Enrollment secret creates a hashed HttpOnly, Secure, SameSite owner session; no Tailscale header trust |
| Use Open Responses and AI SDK               | Implemented bounded profile | `openclaw/default`; text, application functions, streaming/nonstreaming and explicit continuation      |
| Execute tools in the application            | Implemented                 | OpenClaw emits native function calls; the existing SDK executes them and returns correlated output     |
| Refresh without losing a conversation       | Implemented                 | Access-token rotation preserves the grant authorization version                                        |
| Continue after proxy restart or ambiguity   | Explicitly unavailable      | Process-local mapping is lost and possibly admitted work is never replayed                             |
| Read recent execution history               | Implemented, process-local  | Same active grant only; bounded stock history projection; inputs do not claim human authorship         |
| Reopen a completed recent head              | Implemented, process-local  | Explicit returned checkpoint; no automatic adoption or replay; lost on proxy restart                   |
| Generic exactly-once effects                | Explicit non-goal           | Applications own idempotency and deduplication                                                         |
| Media, arbitrary history or background jobs | Rejected                    | Version-zero request profile is text-only; history is a bounded recent execution view                  |

## Scoped proxy and OpenClaw

| Capability                                                 | Status                                   | Current boundary                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Operate published stock OpenClaw                           | Implemented and deterministically tested | Version/tarball/integrity and absence of the native-patch export are checked                           |
| Keep operator credentials private                          | Implemented                              | Exact server credential goes only to one configured loopback origin; redirects are disabled            |
| Prevent caller routing escalation                          | Implemented                              | Agent, model, session and headers are constructed server-side; unknown fields fail closed              |
| Bind upstream response IDs to authority                    | Implemented                              | Grant authorization version, policy fingerprint, agent, tool hash and private conversation are checked |
| Bound continuation state                                   | Implemented                              | Single latest mapping, 30-minute TTL, 1,024 total and eight per grant by default                       |
| Stream stock events                                        | Implemented                              | Byte-preserving SSE relay with bounded observation of IDs, terminal state and function calls           |
| Stop unapproved function publication                       | Implemented                              | Any function item is checked at its first observed event before that frame is published                |
| Handle disconnect or upstream ambiguity                    | Implemented fail-closed                  | Admission is consumed, the upstream is aborted and no automatic replay is available                    |
| Enforce dedicated native-tool policy                       | Configured and stock-tested              | Exact deny/allow ceiling; no bootstrap, context injection, skills, memory, tool search or elevation    |
| Permit native code execution                               | Conditional                              | Only with per-session Docker/Podman, no network/binds and read-only or absent host workspace           |
| Prove static config matches the running service atomically | Not claimed                              | Full files are hashed; reload is off; one supervisor must restart both and require reconsent           |
| Handle subscription credentials                            | Out of scope                             | OpenClaw owns all provider/runtime credentials and refresh behavior                                    |

## Evidence and remaining gates

The deterministic stock suite uses the published OpenClaw process and substitutes
only inference. It proves:

- operator-origin `/exec`, `/elevated` and hallucinated native exec cannot defeat
  a dedicated deny-all agent;
- an unavailable required container sandbox fails before inference;
- the real web SDK and OAuth flow complete two application function calls,
  output continuation, a contextual follow-up, refresh and revoke through stock
  OpenClaw;
- sibling grants, request/header/tool escalation, malformed or oversized input,
  config drift, unapproved streamed functions, expiry, restart and disconnect
  fail at the stated boundaries.

The deterministic suite does not prove subscription inference, real HTTPS
ingress, supervisor setup or Bookhand behavior. Earlier live deployment and
browser evidence are separate. The current Bookhand restore/follow-up/New
conversation sequence remains coordinated owner acceptance; deterministic
verification never spends model allowance or mutates Bookhand.

## Security and reliability invariants

- The browser never receives the OpenClaw operator bearer or private session key.
- A response ID is a lookup key, not a capability; every continuation rechecks
  the exact active grant and policy identity.
- The approved application tool snapshot is reconstructed by the proxy and must
  exactly match what the client submits.
- Native configuration is part of the trusted deployment boundary. Editing it
  during service requires a supervised restart and fresh consent.
- Upstream effects after admission may be ambiguous. No automatic retry or
  generic exactly-once claim is made.
- Tailnet reachability is transport, not owner authorization.
