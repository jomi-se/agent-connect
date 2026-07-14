# 0007: Bootstrap once with a runtime card, then authorize apps through the connector

- Status: accepted; narrow Tailscale profile implemented, hardening deferred
- Date: 2026-07-14

## Context

The prototype prints a one-time pairing code in the connector terminal for each
application session. That proves a browser user had access to a connector-owned
channel, but it is unacceptable as the normal authorization experience for a
headless runtime. A mobile user should not need to open Termux, SSH to a VM, or
operate OmniGENT whenever a new web application requests access.

Two ceremonies have different security purposes:

1. **Runtime bootstrap** establishes which connector key belongs to the user's
   runtime.
2. **Application authorization** lets that connector approve an exact web
   origin and requested authority.

Only the first ceremony requires a channel that predates browser trust in the
connector. Once the browser has a connector public key and endpoint from that
channel, the connector can safely host its own authorization UI.

## Decision

The accountless Tailscale profile will use a one-time operator-channel bootstrap
followed by connector-hosted OAuth-style authorization.

### Bootstrap once

On first setup, the connector generates a durable identity key and emits a
stable **runtime card** through its trusted local operator channel. For the
headless reference deployment, that channel is the terminal or installer
output. Other implementations may use a local native UI, QR display, managed
device enrollment, or an account-backed directory.

The runtime card contains routing and public identity material, not a reusable
bearer credential:

```json
{
  "version": 1,
  "runtimeId": "<connector identifier>",
  "endpoint": "https://device.tailnet.ts.net:8443",
  "connectorPublicKey": {},
  "transportProfile": "tailscale-serve",
  "authorizationServer": "https://device.tailnet.ts.net:8443"
}
```

The user stores this card in a password manager or another trusted personal
store and imports it into each application that should know about the runtime.
Manual transfer is the user-mediated statement that this is the connector they
set up. Re-export without restart is a target recovery operation but no command
implements it yet. Possession
of the public card alone does not authorize agent use.

Before disclosing prompts, application data, or tool results, the SDK challenges
the endpoint and verifies proof of possession of the card's connector key.

### Authorize each application in the browser

For a new application origin, the SDK starts an OAuth 2.0 Authorization Code
flow with PKCE against the connector's authorization server. The authorization
surface is a top-level connector-owned page, not app-rendered UI and not an
iframe.

The connector:

1. authenticates the requesting user from the active transport profile—for the
   initial profile, Tailscale Serve's protected requester identity;
2. derives the client identity from the actual HTTPS origin and validated
   redirect/client metadata rather than trusting a display name from request
   parameters;
3. shows the exact origin, prompt/response authority, subscription-consumption
   warning, tool set, requested duration, and other authorization details;
4. records approval and returns a short-lived, single-use authorization code to
   an exact validated redirect URI;
5. requires the browser app's PKCE verifier and app-instance key during token
   exchange;
6. issues a revocable grant bound to connector key, origin, app id,
   requested scopes, canonical tool hash, and expiry.

Normal reconnections use the existing grant silently. A material privilege
increase—new tools, broader prompt/result access, or a longer policy—requires
incremental approval. Revocation, expiry, connector-key rotation, or app-key
loss requires reauthorization.

The first implementation uses an opaque bearer grant plus S256 PKCE. It does
not yet generate an app-instance key or sender-bind the token with DPoP. That
gap is recorded explicitly rather than implying that the target binding is
already complete.

### Terminal is recovery, not routine UX

After runtime-card export, routine app authorization must not require terminal
access, connector restart, OmniGENT access, or knowledge of a downstream
provider session. The operator channel remains the target surface for recovery,
key rotation, disabling browser authorization, and re-exporting the public card;
those operator commands remain deferred.

## Standards profile

The implementation should compose existing standards rather than inventing a
new consent flow:

- OAuth 2.0 Authorization Code with PKCE and current OAuth security guidance;
- exact redirect URI validation and transaction-bound state/issuer checks;
- OAuth authorization-server and protected-resource metadata where applicable;
- Rich Authorization Requests for structured prompt, result, tool, and policy
  authority;
- optional pushed authorization requests to keep sensitive request details out
  of navigation URLs;
- WebAuthn/passkeys as an optional step-up user-verification mechanism on the
  connector origin.

Client registration/discovery for arbitrary HTTPS origins needs a bounded
spike. Dynamic registration, URL-based client metadata, or an Agent Connect
profile may be required. The project must state any profile extensions plainly
and must not claim generic OAuth conformance before interoperability tests pass.

## Security boundary

- The runtime card authenticates the connector key because the user obtained
  it through a previously trusted operator channel; TLS hostname recognition
  alone is insufficient.
- Tailscale requester identity authenticates the user to the connector; it does
  not replace per-app consent.
- The connector-owned page keeps the approval decision outside the requesting
  app's origin without forcing use of a second physical device.
- PKCE protects authorization codes from interception but does not replace
  exact Origin, redirect, audience, issuer, app-key, and connector-key binding.
- A malicious application can still ask for excessive authority. The connector
  must display trustworthy origin-derived identity and meaningful permissions
  and must fail closed on ambiguity.
- Runtime enrollment proves continuity with the chosen connector, not host
  integrity or benign software.

## Consequences

- First setup retains a deliberate, credible ownership bootstrap.
- Adding an app becomes a same-device redirect-and-consent experience similar
  to connecting an OAuth provider.
- Password managers can hold the reusable runtime card, and passkeys can later
  protect approval on the connector origin without exposing a reusable secret
  to arbitrary apps.
- The connector must include a small hardened authorization web surface and
  durable grant/revocation storage.
- Managed account, push/CIBA, companion-app, extension, and credential-wallet
  profiles remain compatible future UX improvements.

## Implemented profile

The implementation and its exact durable/memory-only boundary are recorded in
[`docs/plan/secure-enrollment-implementation.md`](../plan/secure-enrollment-implementation.md).
It includes a generated high-entropy enrollment passphrase used only on the
connector origin, signed runtime challenges before tool disclosure, pushed
authorization details, top-level consent, PKCE, durable hashed grants,
revocation, and removal of the legacy pairing bypass. It must not be described
as a generally conformant OAuth authorization server.

## References

- [OAuth 2.0 Security Best Current Practice (RFC 9700)](https://www.rfc-editor.org/info/rfc9700/)
- [OAuth 2.0 Rich Authorization Requests (RFC 9396)](https://www.rfc-editor.org/info/rfc9396/)
- [Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/)
