# Popup pairing fails under cross-origin isolation and says the user cancelled

Status: ready-for-agent

An app that needs cross-origin isolation (WASM threads, `SharedArrayBuffer`)
serves `Cross-Origin-Opener-Policy: same-origin` with a COEP. Pairing opens
the gateway's consent page in a popup, and the popup reports back to the app
with `window.opener.postMessage` (`captureAcpPairingCallback` in
`packages/web-sdk/src/acp-pairing.ts`). Under COOP `same-origin`, a popup that
navigates to another origin is severed from its opener for good, even after it
comes back to the app's origin. The app sees the popup as closed, and the SDK
rejects with `cancelled`, "Approval window was closed", about 400 ms in: the
owner is told they cancelled when they did not.

Checked 2026-11-25 in Chromium 159 against a stand-in gateway on a second
origin:

| App headers                                                                  | `crossOriginIsolated` | Popup pairing        | Redirect pairing |
| ---------------------------------------------------------------------------- | --------------------- | -------------------- | ---------------- |
| none                                                                         | false                 | works                | works            |
| COOP `same-origin` + COEP `require-corp` or `credentialless`                 | true                  | fails as `cancelled` | works            |
| COOP `same-origin-allow-popups`                                              | false                 | fails as `cancelled` | works            |
| `Document-Isolation-Policy: isolate-and-require-corp` (or `-credentialless`) | true                  | works                | works            |

The real gateway's socket, app tools, chat and cancellation passed for Codex
and Claude Code under COEP `require-corp`, and tools and cancellation under
`credentialless`, with `crossOriginIsolated` true: only pairing breaks.

## Fix

- Deliver the callback without the opener: the callback page shares the app's
  origin, so a `BroadcastChannel` (or a storage event) reaches the waiting page
  whatever COOP did to the popup.
- Never report a severed popup as `cancelled`. If the callback cannot arrive,
  say why, and point to redirect pairing.
- Document the isolated setups that work: redirect pairing, and
  `Document-Isolation-Policy` where the browser supports it.
- A browser test that pairs a cross-origin-isolated page by popup.
