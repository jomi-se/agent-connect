# Firebase-to-tailnet integration slice

## Goal

Run the first target web application from a non-production Firebase Hosting URL
while its browser-side agent tools are called by the user-owned Codex runtime on
this VM.

```text
Firebase Hosting preview (HTTPS)
  -> fetch/SSE with exact Origin
Tailscale Serve (tailnet-only HTTPS)
  -> authenticated identity headers
Agent Connect gateway (127.0.0.1:8787)
  -> narrow session stream/events
OmniGENT (127.0.0.1:6767)
  -> codex-acp -> Codex
```

## Phase A: gateway envelope

- run the gateway only on loopback;
- configure exact preview and production origins independently;
- require an allowed `Tailscale-User-Login` on actual requests;
- answer valid CORS preflights without requiring identity headers;
- optionally require a bearer token supplied to the app at runtime;
- proxy only `GET /v1/sessions/:id/stream` and
  `POST /v1/sessions/:id/events`;
- expose it on a Tailscale HTTPS port that does not replace the current port 443
  mapping.

## Phase B: non-production application origin

From the grocery application's Firebase project, create a preview channel:

```sh
firebase hosting:channel:deploy agent-connect
```

Record the exact generated `https://...web.app` origin in
`AGENT_CONNECT_ALLOWED_ORIGINS`. Preview URLs are shareable and may still talk
to the application's real Firebase backend. Do not use real grocery data for
the first destructive tool test; begin with read-only tools or a seeded test
record.

## Phase C: remote real-surface proof

1. Start OmniGENT and provision one Codex-backed session.
2. Start the gateway with the preview origin and owner login allowlisted.
3. Expose gateway port 8787 with Tailscale Serve HTTPS on an unused port.
4. Open the Firebase preview on a Tailscale-connected phone or laptop.
5. Run the nonce tool proof through the remote gateway.
6. Inspect browser console, preflight, SSE stream, event POST, gateway logs, and
   the final Codex response.
7. Repeat once with a disallowed Origin and once without Tailscale access.

## After the slice

Replace the shared optional bearer secret with a short-lived pairing capability
bound to Tailscale login, application origin, application session, and tool
snapshot hash. Move OmniGENT session provisioning behind the gateway so an
external application never needs a raw conductor session ID.
