# Secure enrollment and application authorization implementation

Date: 2026-07-14

Status: implemented narrow Tailscale profile; live mobile validation pending.

## Implemented contract

The reference gateway now separates three credentials:

1. A durable Ed25519 connector identity authenticates the enrolled runtime.
2. A high-entropy enrollment passphrase enrolls a browser device on the
   connector-owned origin. Only an scrypt verifier is stored.
3. A revocable application grant authorizes one exact HTTPS origin, app id,
   scope set, and canonical tool snapshot. It is exchanged through a
   short-lived, single-use code protected by S256 PKCE.

The first gateway start creates an owner-only state file and prints two clearly
separated outputs: a public runtime card and an enrollment secret. Save the
secret in a password manager. The application imports only the public runtime card;
the passphrase is entered only on the top-level connector page.

Before sending tool schemas, the web SDK sends a fresh nonce and verifies the
connector's Ed25519 signature using the pinned runtime card. It then pushes the
authorization details, redirects to `/authorize`, validates callback URL and
state on success or denial,
and exchanges the code. The connector page derives the application's identity
from the actual request Origin and exact redirect URI, not a supplied logo or
display name.

Enabling connector authorization disables the old terminal pairing exchange.
The connector-owned consent and grant-revocation POSTs require the connector's
own Origin, and every request also requires an allowlisted Tailscale requester.
Revoking a durable grant immediately blocks capabilities already issued from
that grant.

## State and limits

Durable:

- connector private/public key;
- enrollment passphrase salt and verifier;
- device token hashes and expiry;
- application grant token hashes, bindings, expiry, and revocation;
- the capability-signing secret.

Intentionally still memory-only:

- pending pushed authorization requests;
- authorization codes;
- logical-to-provider session mappings;
- failed-passphrase rate-limit counters.

This is an Agent Connect OAuth-style profile, not a claim of general OAuth
server conformance. The narrow implementation requires the complete
`agent:prompt`, `agent:result`, and `tools:invoke` scope set rather than
pretending to support partial grants. Current grants are bearer tokens stored in browser
`sessionStorage`; app-instance proof/DPoP, metadata discovery, incremental
authorization, device management, recovery/key rotation, audit history, and a
distributed rate limiter remain deferred.

## Configuration

Required for the enrolled profile:

```text
AGENT_CONNECT_STATE_PATH=/owner-only/path/connector.json
AGENT_CONNECT_PUBLIC_ENDPOINT=https://device.tailnet.ts.net:8443
AGENT_CONNECT_TRANSPORT_PROFILE=tailscale-serve
AGENT_CONNECT_ALLOWED_ORIGINS=https://agent-connect-demo.web.app
AGENT_CONNECT_ALLOWED_TAILSCALE_USERS=user@example.com
```

Do not set `AGENT_CONNECT_ENROLLMENT_PASSPHRASE` for the normal flow; let the
connector generate a high-entropy value. Do not put the passphrase in the web
application, Firebase configuration, URL, or browser storage.

## Validation contract

- **VAL-ENROLL-001:** runtime identity and passphrase verifier survive restart;
  the SDK verifies a signed fresh challenge before disclosing tools.
- **VAL-AUTHZ-001:** exact Origin/redirect/app/tool metadata/scopes are bound;
  consent displays tool names, descriptions, schemas, callback, and expiry;
  S256 PKCE, state, short code lifetime, single use, and same-origin connector
  forms fail closed.
- **VAL-REVOKE-001:** grants are hashed at rest, durable, and revocation blocks
  both new session creation and an existing session capability.
- **VAL-LEGACY-001:** legacy pairing is unavailable whenever enrolled connector
  authorization is configured.

Automated tests cover the passing flow, restart, wrong connector proof, wrong
redirect/callback URL, wrong passphrase, incomplete scopes, changed tool
metadata, cross-site consent/revocation, bad PKCE, code replay,
denial/state substitution, revocation, unknown-event rejection, and pairing
bypass.
