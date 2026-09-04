# Parallel expiring application sessions MVP

Status: implemented, validated, and committed on 2026-08-31

## User-visible goal

A browser losing its in-memory Agent Connect state must not strand the user
behind the old task. A new page instance can create a new opaque application
session under the existing grant even while an older session still has live or
parked work. Different application sessions may run concurrently; the existing
one-active-task rule remains local to each session.

This MVP deliberately does not recover a lost browser task. Completed-turn
continuation works only while the application retains its opaque continuation
checkpoint. After refresh, starting a fresh session starts over. The abandoned
session remains isolated by its own capability until its lease expires, then
the gateway durably retires it and best-effort cancels any retained run.

## Accepted boundaries

- Presenting the application grant always provisions an independent
  application and provider session; it does not replace, wait for, or adopt an
  earlier one. Reconnecting to a specific session requires that session's own
  capability, which is the only credential that names one. (`freshSession` is
  retained as a no-op for compatibility and is deprecated.)
- One response chain may be live within each application session.
- Up to eight live sessions may exist for one grant, application, and approved
  tool snapshot. The ninth is refused with `429`, `Retry-After`, and a
  `manageUrl` pointing at the gateway's session page.
- Session lifetime slides on activity rather than running from issuance, and is
  independent of the capability TTL. Three clocks govern it: idle (15 min by
  default), unanswered function call (3 min), and a running turn making no
  progress (30 min). All three are configurable.
- Expiry removes in-memory authority, writes the existing durable retirement
  tombstone, asks the response engine to cancel retained runs, and releases the
  provider session and its workspace.
- No automatic pending-call redelivery, DOM-state reconstruction, cross-tab
  ownership protocol, or generic task recovery is part of this MVP.

## Validation contract

### VAL-PARALLEL-001: a dangling session does not block a fresh session

Surface: HTTP API.
Needs: authorized application grant and a first session parked on an
application function call.
Behavior: creating a fresh session succeeds, receives a distinct opaque and
provider session, and can start work while the first session remains isolated.
Evidence: route integration test plus real-Omnigent integration coverage where
provider-dependent behavior is involved.

### VAL-PARALLEL-002: concurrency remains isolated per session

Surface: HTTP API.
Needs: two application sessions under the same grant and tool snapshot.
Behavior: each session admits its own chain, while a second unlinked chain in
either individual session is still rejected.
Evidence: route integration test observing two backend runs with distinct
provider session IDs and the existing per-session busy regression tests.

### VAL-PARALLEL-003: expired sessions stop consuming authority and capacity

Surface: HTTP API and durable gateway state.
Needs: controllable clock and short configured session lifecycle timeouts.
Behavior: after the activity deadline expires, the old capability is rejected, the session
is durably retired, a retained run is cancelled, and a new fresh session can use
the released capacity.
Evidence: route integration test across expiry and gateway reconstruction.

### VAL-PARALLEL-004: browser refresh semantics are honest

Surface: browser demo and public integration documentation.
Needs: Canvas configured to request a fresh session.
Behavior: a new page instance starts a new conversation without claiming to
recover the lost task; completed-turn continuation within the current page
still works.
Evidence: browser flow and source-of-truth documentation review.

## Implementation state

- [x] Located the destructive replacement and live-task refusal in
      `packages/gateway/src/gateway.ts`.
- [x] Changed the in-progress implementation so fresh provisioning no longer
      retires or waits for predecessors.
- [x] Added a session lease to managed sessions and a response-engine expiry
      operation.
- [x] Stabilized expiry/reaping behavior around the signed capability lease,
      durable tombstones, process-local capacity, and restart reconstruction.
- [x] Replaced the fixed capability-TTL lease with a sliding activity clock and
      the separate parked-call and stalled-turn clocks, so an abandoned tab is
      released in minutes and a long turn is never reaped underneath itself.
- [x] Added provider-session teardown on expiry, so a retired session no longer
      leaks an Omnigent runner and a session workspace.
- [x] Added the owner session console at `GET /sessions`, with live state,
      turn counts, cumulative tokens and cost, retirement deadlines, recent
      ended sessions rebuilt from the chain ledger, and explicit termination.
- [x] Replaced destructive-replacement tests with parallel-session and expiry
      tests.
- [x] Updated ADR 0011, current scope, integration guide, and SDK wording.
- [x] Focused route tests and gateway typecheck pass.
- [x] A focused pinned real-Omnigent test proved two independent sessions can
      enter two distinct provider sessions concurrently.
- [x] Gateway and web SDK focused suites pass.
- [x] The complete pinned real-Omnigent and process-crash gate passes through
      `npm run verify:full`.
- [x] The complete Canvas Playwright suite passes, including a page-refresh
      regression that starts a second independent session under the saved grant.
- [x] `npm run analyze`, formatting, diff checks, and final source review pass.
- [x] Commit the completed change.

## Resume notes

No service restart or deployment was performed as part of this change. The
currently running private gateway must be rebuilt/restarted before a manual
phone demo exercises this code.
