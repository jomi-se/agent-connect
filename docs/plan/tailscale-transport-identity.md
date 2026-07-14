# Tailscale transport identity plan

Date: 2026-07-14

Status: proposed next security slice.

## Outcome

A hosted web application connects to a user-selected Tailscale Serve endpoint
and can distinguish an enrolled Agent Connect runtime from an arbitrary service
at a plausible URL. The connector authenticates the requesting Tailscale user,
and the user approves the application separately.

This slice proves a Tailscale-specific bootstrap profile. It does not claim
portable arbitrary-URL authentication or host integrity.

## Capability inventory

| Capability                       | Observable result                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Inspect local transport posture  | Connector reports whether Tailscale is active and whether its advertised route is compatible with Serve |
| Reject unsafe exposure           | Profile refuses Funnel/public mode and a non-loopback gateway listener                                  |
| Describe local identity          | Enrollment UI shows endpoint, local node/user context, and connector-key fingerprint                    |
| Bind connector identity          | First-use pairing binds the selected endpoint to a generated connector public key                       |
| Authenticate requester           | Gateway accepts only Serve-injected, allowlisted Tailscale user identity                                |
| Authorize application separately | Connector-hosted OAuth consent names exact Origin, app id, tools/scopes, and browser/app key            |
| Verify continuity                | Later sessions require proof of the enrolled connector private key                                      |
| Report assurance honestly        | SDK distinguishes provider-backed, enrolled, TOFU, and unverified properties                            |
| Rotate or remove binding         | User can invalidate the connector identity and re-enroll deliberately                                   |

## Implementation slices

### 1. Transport inspection and diagnostics

- Add an internal transport-profile boundary to the gateway.
- Read local Tailscale status/LocalAPI through a narrow adapter.
- Determine the local node/user identity and advertised DNS endpoint.
- Inspect or require operator-supplied evidence of the active Serve mapping.
- Fail closed when the gateway is not loopback-only, identity headers are
  missing, or the profile cannot distinguish the intended private mode.
- Emit a human-readable diagnostic command/endpoint that explains each failed
  prerequisite without exposing credentials.

Important investigation: confirm the most stable supported interface for
machine-readable Serve-versus-Funnel configuration. Do not parse human CLI
output into a security boundary unless no supported API exists and the risk is
explicitly accepted.

### 2. Connector identity and enrollment

- Generate a connector signing key and store it with owner-only permissions;
  use OS key storage later where available.
- Derive an opaque `runtimeId` from the public-key thumbprint.
- Replace the generic startup code with a stable, non-secret runtime card that
  includes runtime id, endpoint, connector public key, and transport profile.
- Export the card through the connector's trusted local operator channel once
  and allow later re-export without restart.
- Record the approved binding durably and support list/revoke/rotate commands.
- Require a nonce-bound connector signature during connection establishment.

The initial trusted channel can be terminal plus copy/paste into a password
manager. QR transfer is optional polish, not a different trust model. Routine
application authorization moves to the connector-owned OAuth page described in
the [authorization plan](connector-oauth-authorization.md).

### 3. Browser SDK transport profile

- Introduce a harness-neutral runtime/profile option while preserving the
  current API during migration.
- Store only the enrolled runtime id, endpoint hint, connector public key, and
  scoped application grant—never OmniGENT identifiers.
- Verify the connector's challenge signature before sending a prompt or tool
  result.
- Expose normalized assurance and warnings to the host application.
- Treat domain recognition as UX assistance only.

### 4. Application authorization hardening

- Generate an origin-scoped app-instance key in the browser where platform
  storage permits it.
- Run OAuth Authorization Code with PKCE on a top-level connector-owned page;
  identify the user from Tailscale Serve and display exact origin and authority.
- Bind grants to connector key, app key, exact Origin, app id, tool hash,
  prompt/result scopes, and expiry.
- Add per-request proof or an authenticated session so a copied bearer token is
  insufficient by itself.
- Preserve the underlying harness sandbox and approval policy as an independent
  protection boundary.

### 5. Real-surface validation

Prove the following in a real browser on a tailnet device:

1. Correct private Serve endpoint + enrolled connector + allowed user succeeds.
2. Same endpoint with the wrong connector key fails before prompt ingress.
3. A lookalike `.ts.net` or custom URL cannot claim Tailscale assurance merely
   from its hostname.
4. Funnel/public access, missing identity headers, wrong Tailscale user, wrong
   Origin, changed tools, expired grant, and replayed handshake fail closed.
5. Connector restart preserves identity; key rotation invalidates old grants.
6. A successful session still completes the live OmniGENT/Codex dynamic-tool
   round trip.

Capture browser network evidence, gateway decisions, local transport posture,
and the downstream tool trace. Redact account identifiers and credentials.

## Deferred profiles

- Microsoft Dev Tunnels: investigate whether provider authentication can be
  consumed cleanly by arbitrary hosted browser applications; the service is a
  development preview and not a production default.
- Managed Agent Connect identity: OAuth device enrollment, signed runtime
  certificates, directory, relay, recovery, and revocation.
- Custom URL: direct QR/fingerprint enrollment or configured OIDC/mTLS.
- Hardware/cloud attestation: optional higher-assurance policy, never required
  for the open-source baseline.
