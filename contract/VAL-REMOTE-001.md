# VAL-REMOTE-001: Firebase browser reaches the local runtime safely

## Assertion

A browser application loaded from an allowlisted Firebase Hosting preview
origin can run a dynamic application tool through the tailnet-only Agent Connect
gateway and receive the same-turn Codex result. A disallowed origin or
Tailscale login cannot access the application or response routes.

## Required evidence

- gateway unit tests prove preflight behavior, exact Origin enforcement,
  Tailscale login enforcement, optional bearer enforcement, and bounded
  response routing;
- Tailscale Serve status shows a dedicated HTTPS mapping to the loopback
  gateway without replacing unrelated mappings;
- a real browser loaded from the Firebase preview completes the unpredictable
  nonce flow through that HTTPS URL;
- browser console and inspected network requests show no mixed-content, CORS,
  preflight, SSE, or event-post failures;
- negative probes demonstrate rejection of an unlisted Origin and login.

## Current status

The Firebase demo completed a real mobile-browser Codex/tool/page-mutation turn
through private Tailscale Serve on 2026-07-17, including a successful turn after
gateway restart and Omnigent-host reconnection. Automated gateway tests cover
the disallowed Origin and requester cases. A sanitized browser evidence bundle
and explicit console/network capture remain submission-presentation work.
