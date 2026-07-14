# Connector-hosted OAuth authorization plan

Date: 2026-07-14

Status: narrow Tailscale implementation complete; target hardening remains.

## Outcome

A user operates the connector terminal once to export a stable runtime card and
saves it in a password manager. Adding a new hosted web application later
requires only a connector-owned browser consent page on the same phone. It does
not require SSH, connector restart, OmniGENT interaction, or copying a fresh
terminal secret.

## Target user flow

### First connector setup

```text
connector starts
  -> generates durable identity key
  -> validates Tailscale Serve posture
  -> prints or exports runtime card

user
  -> saves card in password manager
  -> leaves connector running
```

### First use from an application

```text
app
  -> imports/autofills runtime card
  -> verifies signed connector challenge
  -> creates app-instance key and PKCE verifier/challenge
  -> pushes a structured authorization request
  -> navigates to connector /authorize

connector authorization page
  -> Tailscale identifies requesting user
  -> shows actual app origin and requested authority
  -> user approves or denies

connector
  -> redirects to exact app callback with one-use code

app
  -> exchanges code with PKCE verifier and app-key proof
  -> receives scoped revocable grant
  -> starts the authorized agent session
```

On mobile, a full-page redirect with state restoration is the required path;
popup support is an optional desktop convenience. The authorization surface
must not be embedded by the requesting app.

### Later use

- Reuse the grant silently while it remains valid and the requested authority
  is equal to or narrower than the approved policy.
- Require incremental consent when prompt/result access, tool set, mutation
  class, duration, or another meaningful privilege expands.
- Let the user list and revoke applications from the connector-owned page.

## Capability inventory

| Capability                         | Observable result                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Export stable runtime card         | Connector emits a re-exportable non-secret card containing endpoint and public identity               |
| Import and pin runtime             | SDK persists the runtime id and connector public key without provider ids                             |
| Verify connector before disclosure | Wrong-key endpoint fails before prompt, schema, or application data ingress                           |
| Discover authorization endpoints   | SDK obtains signed/verified authorization metadata for the enrolled runtime                           |
| Identify arbitrary browser app     | Connector binds the request to an exact HTTPS origin, redirect, app id, and app-instance key          |
| Review structured authority        | Consent page shows prompt/result access, tools, mutation risk, duration, and subscription-use warning |
| Approve through connector origin   | User completes the flow on a top-level Tailscale-hosted connector page                                |
| Protect code exchange              | Authorization code is single-use, short-lived, redirect-bound, and PKCE-protected                     |
| Issue sender-bound grant           | Grant is bound to connector key, origin, app key, tool hash, scopes, and expiry                       |
| Reuse and step up                  | Existing authority is silent; expanded authority prompts again                                        |
| Revoke and audit                   | Connector page lists grants and their meaningful authorization events                                 |

## Implementation slices

### 1. Runtime identity and export

- Generate and durably store the connector identity key.
- Define a canonical, versioned runtime-card schema and compact import format.
- Implement `runtime-card show/export` without restarting the gateway.
- Include no bearer token, reusable pairing password, OmniGENT id, or Codex
  credential.
- Verify imported card syntax, key thumbprint, profile, and supported metadata
  before connecting.

### 2. OAuth metadata and client identity

- Expose authorization-server and protected-resource metadata from the
  connector.
- Decide and document arbitrary web-client registration: dynamic registration,
  URL-based client metadata, or a narrow Agent Connect profile.
- Validate HTTPS client origin, exact redirect URIs, issuer, audience, and
  response state.
- Fetch any display metadata from a trusted origin-bound location; never let
  request parameters impersonate another application's name or logo.

### 3. Authorization request and consent UI

- Create a pending authorization record before navigation.
- Prefer pushed requests or an opaque request URI so tool schemas and policy
  details do not leak through URLs, referrers, or browser history.
- Represent detailed authority using a versioned structured authorization
  object compatible with OAuth Rich Authorization Requests.
- Serve a mobile-first connector-owned approval/denial page.
- Apply `frame-ancestors 'none'`, restrictive CSP, no-referrer policy, safe
  return navigation, and explicit expiry.
- Authenticate the user through the active transport profile and support
  optional WebAuthn step-up later.

### 4. Code exchange and grants

- Generate a short-lived single-use authorization code.
- Require S256 PKCE and reject downgrade or verifier reuse.
- Bind code and grant to connector key, issuer, audience, exact Origin,
  redirect, client/app id, app-instance key, structured authority, tool hash,
  and expiry.
- Store grants durably and make revocation effective for new requests and live
  session renewal.
- Keep raw OmniGENT sessions and provider credentials gateway-internal.

### 5. SDK integration

- Add runtime-card import/export types without exposing the transport provider
  in task/tool APIs.
- Implement redirect state persistence and recovery for mobile navigation.
- Verify connector proof and OAuth response binding before accepting a grant.
- Expose approval-required, denied, expired, revoked, and scope-increase states
  as stable SDK outcomes.
- Keep the flow independent of whether the application payload is the current
  custom API or the pending AG-UI profile.

## Real-surface validation

Prove through a real Firebase-hosted app on a phone connected to the tailnet:

1. Initial runtime card is exported once, stored/retrieved, and imported by a
   fresh app origin.
2. The app verifies the connector key before sending prompt or tool data.
3. The connector authorization page opens without terminal access and displays
   the exact app origin and requested tools.
4. Approval returns to the app and completes the live OmniGENT/Codex dynamic
   tool round trip.
5. A second use with equal authority is silent.
6. A new tool or broader authority requires incremental consent.
7. Denial, expiry, revocation, wrong Tailscale user, wrong connector key, wrong
   Origin, redirect mismatch, issuer mismatch, PKCE failure, code replay, app-key
   substitution, and authorization-detail tampering fail closed.
8. The connector can re-export the public card and list/revoke grants without
   restart.
9. No terminal, OmniGENT UI, raw provider id, or Codex credential appears in the
   normal new-app flow.

Capture the mobile redirect sequence, address-bar origins, consent screen,
network exchanges, gateway decisions, and final tool trace. Redact user
identifiers, codes, grants, and connector secrets.

## Deferred UX profiles

- Managed Agent Connect authorization broker with account recovery and shared
  runtime directory.
- Push/CIBA approval to an enrolled phone or authenticator.
- Native companion, browser extension, or credential-wallet integration.
- Passkey-required approval and transaction confirmation.
- Signed application registry and policy-based low-risk auto-approval.

These may remove runtime-card import or provide notifications, but they do not
change the connector's need to bind authority to a real app origin and an
explicit user policy.

## Implementation delta

The current code implements the runtime key/card, generated enrollment
passphrase and device cookie, signed challenge before schema disclosure, pushed
request, connector-owned consent page, exact HTTPS redirect, state, S256 PKCE,
single-use code, durable hashed grants, scope/tool bindings, and revocation.

It does not yet implement re-export/rotation commands, OAuth discovery
metadata, Rich Authorization Request objects, app-instance keys/DPoP,
incremental consent, full audit history, passkeys, durable pending requests or
codes, durable provider sessions, or mobile real-surface evidence. See the
[implementation contract](secure-enrollment-implementation.md).
