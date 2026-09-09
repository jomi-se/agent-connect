# OpenClaw browser connection client

Date: 2026-09-06.
Status: implemented SDK contract; native composition and live acceptance remain pending.

## Public shape

`packages/web-sdk/src/openclaw-connection.ts` is the thin browser-side owner of
OpenClaw discovery, delegated OAuth and credential renewal. It does not create a
runtime card, enroll a device, store credentials, render UI or interpret native
OpenClaw policy.

The intended flow is:

1. `discoverOpenClawProvider({ providerUrl, experience })` validates the two
   well-known metadata documents. `experience` is either `tailscale` or `https`;
   it selects owner-login copy and deployment experience, never a browser-forged
   identity header or a hostname trust rule.
2. `beginOpenClawAuthorization({ provider, redirectUri, tools, callerContext })`
   creates PKCE and PAR, then returns an authorization URL and serializable local
   transaction. `callerContext` can retain a book id or draft across redirect but
   is not sent to the provider. The transaction contains the PKCE verifier and
   belongs in caller-controlled session-scoped storage.
3. `completeOpenClawAuthorization(...)` binds the callback to the saved provider,
   issuer, RFC 9207 `iss`, client origin, redirect URI, resource, state and fixed
   application-tool snapshot before exchanging the code.
4. The resulting `OpenClawConnection` contains only the selected HTTPS Responses
   endpoint, opaque access and refresh credentials, expiries, public model alias
   `openclaw/default`, canonical fixed application tools and their SHA-256 hash.
   It contains no grant id, native agent/profile id or policy internals. Persist
   this app-level connection separately from book-scoped conversation state.
5. Pass `createOpenClawAccessTokenGetter(...)` to
   `createAiSdkOpenResponsesModel`. One shared getter instance single-flights
   proactive refresh for all features in that application instance.
6. `revokeOpenClawConnection(...)` revokes the refresh-token family. The caller
   then deletes its own persisted record.

The getter's `saveConnection(next, expected)` callback is an atomic compare-and-
swap boundary. It must save only while `expected` is still current and return
false after disconnect or provider replacement. This keeps a late refresh
response from resurrecting a removed connection. Independent tabs or getter
instances are not serialized by that compare-and-swap: two refresh POSTs with
the same old token can trigger family replay revocation before either save.
Cross-tab users need a lock around the complete read-refresh-save operation or
independent connections. After an ambiguous refresh, failed rotated-token save,
or generic `invalid_grant`, the getter makes no retry and requires fresh
authorization. Create a new getter after a new connection.

Applications must not retry inference automatically after a 401. They surface
the authorization failure and retain caller-owned draft/conversation state for
reauthorization.

## Version-zero wire

The selected provider is a canonical HTTPS origin. Discovery uses
`/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource`; all advertised authorization, PAR,
token, revocation and `/v1/responses` resource URLs must remain on that origin.
Metadata also fixes the public model alias. Redirects, URL credentials and
fragments are rejected; fetches use `redirect: "error"` and
`credentials: "omit"`.

The public `client_id` is the redirect URI's canonical origin, and the redirect
URI is therefore same-origin with it. PAR is a form POST to
`/agent-connect/oauth/par` with `response_type=code`, `scope=responses`, exact
resource, state, S256 PKCE and:

```json
[
  {
    "type": "agent_connect",
    "application_tools": [
      { "name": "...", "description": "...", "inputSchema": {} }
    ]
  }
]
```

The browser navigates to the advertised authorization endpoint with only
`client_id` and `request_uri`. Code exchange and rotating refresh use standard
form fields plus the fixed resource. Revocation submits the refresh token,
`token_type_hint=refresh_token` and client id. Credentials are never placed in a
URL or log message. JSON responses are read through a 64 KiB bound.

The real Bookhand Tutor snapshot measured during implementation has 21 tools:
23,633 bytes as authorization-details JSON and 32,136 bytes as the complete
URL-encoded PAR form. That leaves about 33 KiB headroom under the provider's
64 KiB decoded-form limit. A no-tool AI feature is also valid and hashes the
empty fixed snapshot.

## Error and evidence boundary

Callers receive only `OpenClawConnectionError`, with typed codes for invalid
input, transport failure, discovery/profile mismatch, denial, transaction
mismatch, token exchange, local refresh-token expiry, changed connection,
reauthorization and revocation. A generic OAuth `invalid_grant` is not relabeled
as revoked or expired because the wire does not prove which happened.

The focused SDK tests use an owned OAuth contract fixture. They prove request
shape, validation, PKCE transaction behavior, token rotation, single-flight and
the disconnect/refresh race; they are not evidence that a real OpenClaw runtime
or owner-login experience works. Stock plugin compatibility is covered by the
pinned OpenClaw plugin-host suite. Owner-reported Bookhand evidence and its
remaining limitations are retained in the [archived closeout ledger](../archive/plans/stock-openclaw-vertical-closeout.md).
