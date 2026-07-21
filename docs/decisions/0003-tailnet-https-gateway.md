# 0003: Put a loopback gateway behind Tailscale Serve

- Status: accepted
- Date: 2026-07-13

## Context

The first target application is hosted on Firebase and therefore runs from an
HTTPS origin outside the agent VM. A browser page cannot safely call a raw HTTP
tailnet IP from that origin. Directly exposing Omnigent would also leave CORS,
authorization, route scope, and later action durability at the wrong boundary.

The VM already has a Tailscale HTTPS hostname. Its port 443 Serve mapping is in
use by another local Vite preview, so the first Agent Connect deployment must
not replace that mapping implicitly.

## Decision

Run an Agent Connect gateway on `127.0.0.1` and expose it only through Tailscale
Serve HTTPS. Use a separate HTTPS port initially.

The first security envelope has three independent checks:

1. tailnet reachability and tailnet policy;
2. a Serve-injected Tailscale login checked against an explicit allowlist;
3. an exact browser Origin allowlist, with an optional runtime bearer token.

The gateway exposes only the session stream and event routes required by the
web SDK. It does not expose raw Codex app-server or the full Omnigent API.

Firebase Hosting serves the application only. A Firebase preview channel is the
first non-production application origin; it does not host the agent gateway.

## Consequences

- the browser-to-gateway hop has valid HTTPS without moving the runtime out of
  the user's environment;
- the application device must be connected to the tailnet;
- the gateway may trust Serve identity headers because its listener remains on
  loopback;
- CORS is enforced by the gateway and is not treated as user authentication;
- a published Firebase preview URL may still use production Firebase backend
  resources unless the application selects a separate project or emulators;
- multi-user pairing and expiring session-scoped capabilities remain required
  before a general release.
