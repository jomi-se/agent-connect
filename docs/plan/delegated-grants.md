# Provider-owned delegated grants

Date: 2026-09-06.

Status: bounded core implemented; HTTP endpoints, owner login/consent UI and
OpenClaw integration are separate work.

This module is the durable authorization core for a public browser client that
connects to one operator-configured Responses resource. It deliberately does
not implement OAuth discovery or HTTP response shapes. Routes can translate its
typed methods and errors into the applicable OAuth responses without teaching
the core about a web framework or OpenClaw internals.

Implementation: `packages/gateway/src/delegated-grants.ts`.

## Authority model

Version zero identifies an application by its canonical HTTPS origin. The
redirect URI must be canonical HTTPS on that same origin. This is useful origin
binding, not publisher attestation: it proves neither who operates the origin
nor that two origins share a publisher.

The gateway configuration fixes the exact Responses resource. An application
must repeat that resource during authorization, code exchange and refresh, but
cannot choose an arbitrary resource for a new grant. Access verification needs
only the bearer and the configured resource. When a browser `Origin` is
available, the verifier can additionally require it to match the client origin;
non-browser provider calls are not made to invent a client-id request header.

An authorization request contains a fixed snapshot of application tools. The
existing gateway validator and canonical hash are reused, with one intentional
extension: an empty snapshot is valid for text-only features. Non-empty tools
retain the existing name, description and JSON-schema constraints. The pinned
AI SDK adapter omits `strict` when the application does not configure it, so
version zero approves that exact shape and rejects either explicit strict value.

Provider-native authority never comes from authorization request parameters.
The application-tool snapshot is the baseline. The only optional native
capabilities in this core are:

- `public_web_search`
- `sandbox_code_execution`

Sandboxed execution does not imply host filesystem access. There is no host
filesystem capability in the type or runtime allowlist. The host integration
must still fail closed unless the named policy really supplies the documented
isolation.

The operator supplies an allowlist of policies. Each entry fixes a policy
reference, an agent id, its exact native capability list, and an integration-
computed fingerprint over the effective host policy. Approval accepts only a
policy reference from that list. The trusted owner-authentication integration,
not application input, supplies the verified owner subject. A changed agent,
capability set or policy fingerprint invalidates verification and refresh; an
old grant is never silently widened after a configuration change.

## API and lifecycle

`DelegatedGrantService` exposes framework-independent operations:

1. `createRequest` implements the durable-core side of a pushed authorization
   request: it validates the public client, redirect, configured resource, S256
   PKCE challenge and application-tool snapshot, then returns a `requestUri`.
   Requests are memory-only, finite-lived and capped. `getRequest` supports the
   consent view and `deny` consumes a rejected request.
2. `approve` takes a trusted owner subject and an offered policy reference. It
   durably commits the grant before returning a short-lived authorization code.
3. `exchange` checks the exact client, redirect and resource binding plus the
   PKCE verifier. A successful exchange consumes the code and durably commits
   hashes of a new access/refresh pair before returning either token.
4. `refresh` checks the refresh token, client and resource, then rotates both
   credentials. The grant id, app subject and approved authority remain stable.
   The previous refresh and access tokens stop verifying. A bounded history of
   spent refresh-token hashes lets replay of an old family member revoke the
   current family; a random invalid token cannot revoke a grant.
5. `verify` returns the stable application principal and exact authority for an
   active access token. The result contains no raw credential.
6. `recheck` validates that immutable result again immediately before provider
   effects. It observes intervening refresh, revocation, expiry or policy
   changes and can also compare the parsed request's exact tool snapshot.
7. `revoke` is the trusted owner/operator grant-id operation.
   `revokeByToken` supports a public revocation endpoint without letting the
   application name and revoke another grant id.

Access tokens use the `ac_access_` prefix, refresh tokens `ac_refresh_`, and
authorization codes `ac_code_`. The provider authentication hook can therefore
claim malformed or invalid Agent Connect credentials terminally instead of
falling through to an owner bearer mechanism. Prefixes are routing hints, not
authentication; all authorization comes from token-hash verification.

## Persistence and failure behavior

Only SHA-256 access and refresh token hashes are persisted. Raw tokens and
authorization codes are not. Grant records contain the stable grant id and
subject inputs, client/resource binding, fixed application-tool snapshot,
selected agent, exact approved capabilities and policy fingerprint.

The built-in store writes and syncs a mode-0600 temporary file in a mode-0700
directory, atomically renames it over the state file, then syncs the directory.
If the post-rename directory sync fails, the service enters a fail-closed state:
verification/recheck deny and other operations require reconstructing the
service from disk. This avoids serving stale in-memory authority after an
uncertain commit. An injected store can be used by another host as long as
`save` throws before commit on failure and returns only after commit.

Every durable mutation is clone, save, then publish in memory. For failures
known to occur before commit, a failed approval returns no code, a failed
exchange returns no usable token, and a failed refresh leaves the previous
refresh token valid for a retry. Those failures do not mutate the in-memory
grant or poison a later write. A post-rename uncertainty is different: the file
may contain a token rotation whose raw credential was never returned. The
service therefore stops serving, and the application must reload and may need
to reconnect rather than retry the old credential. Refresh and code exchange
also reject reentrant reuse; ordinary synchronous calls serialize rotation so
only the first use succeeds. Revocation clears both stored token hashes after
the revocation record commits.

Refresh clients must use a single-flight refresh operation. A detected replay,
or a lost response after the provider durably rotated the family, requires a
fresh authorization connection rather than speculative reuse of either token.
The persisted spent-token history is capped at 256 hashes per finite-lived grant
to keep each record bounded.

Authorization requests and codes have finite TTLs and bounded maps. Access
tokens have finite expiry. A grant has an absolute finite lifetime fixed at
approval; refresh never moves that boundary, and token expiry is capped by it.
The core intentionally defines no universal token, model, cost or execution
budget. Resource policy can add bounded limits where they are real and
enforceable.

## Not implemented here

- OAuth discovery, authorization/token/revocation routes or CORS
- owner authentication, consent presentation or denial redirects
- OpenClaw plugin registration and native policy enforcement
- sandbox provisioning or claims about its isolation
- runtime cards, enrollment passphrases, devices or application sessions

Those concerns stay in their existing host-specific layers. In particular,
this module does not reuse `ConnectorAuth`: that class couples legacy runtime
card, enrollment, device and session concerns and has no rotating refresh-token
family. It reuses only the safe tool normalization/hash and the established
atomic file-write shape.
