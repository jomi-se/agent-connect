# VAL-REMOTE-001: Firebase browser reaches the local runtime safely

## Assertion

A browser application loaded from an allowlisted Firebase Hosting preview
origin can run a dynamic application tool through the tailnet-only Agent Connect
gateway and receive the same-turn Codex result. A disallowed origin or
Tailscale login cannot access the session routes.

## Required evidence

- gateway unit tests prove preflight behavior, exact Origin enforcement,
  Tailscale login enforcement, optional bearer enforcement, and narrow proxying;
- Tailscale Serve status shows a dedicated HTTPS mapping to the loopback
  gateway without replacing unrelated mappings;
- a real browser loaded from the Firebase preview completes the unpredictable
  nonce flow through that HTTPS URL;
- browser console and inspected network requests show no mixed-content, CORS,
  preflight, SSE, or event-post failures;
- negative probes demonstrate rejection of an unlisted Origin and login.

## Current status

Partial. The gateway implementation and focused unit evidence exist. A grocery
application preview URL and remote real-browser run are still required.
