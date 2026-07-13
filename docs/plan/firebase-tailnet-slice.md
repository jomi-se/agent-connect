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

## Phase B: dedicated demo application origin

Before changing the grocery application, create a separate Hosting-only
Firebase project and deploy `apps/firebase-canvas` through the repository's
manual GitHub Actions workflow. Its stable live URL is the non-production demo
origin:

`https://PROJECT_ID.web.app`

Record that exact origin in `AGENT_CONNECT_ALLOWED_ORIGINS`. The Canvas demo has
no Firebase backend and writes only to its own in-memory DOM. Once this passes,
integrate a Firebase preview channel or separate development project for the
grocery application.

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
