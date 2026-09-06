# Native OpenClaw application-principal seam

Date: 2026-09-06.
Status: accepted seam; upstream patch and isolated verification are in progress.
Target: pinned OpenClaw 2026.9.1 only.

## Decision

Add one endpoint-specific plugin registration for native `POST /v1/responses`.
It is an authentication and request-policy seam, not a replacement HTTP route,
an operator credential, or a general plugin auth override.

The host API is `api.registerOpenResponsesApplicationAuth(provider)`. The
registration has two phases:

1. `authenticate(request)` examines request metadata only. It returns `pass` for
   credentials outside its namespace, terminal `deny` for an invalid, expired,
   or revoked credential that it claims, or a verified application principal.
2. `authorize({ principal, request })` runs after the existing bounded Responses body
   parser and schema validation but before URL/media fetch, session creation, or
   agent execution. It validates the fixed approved client-tool snapshot and any
   other grant-owned request constraints. It may only allow or deny; it cannot
   rewrite routing or mint operator authority.

Only one active plugin may own this registration. The host namespaces the
verified stable subject by that plugin id and resolves it to a durable native
profile. A plugin cannot submit a profile id and therefore cannot impersonate
the owner or another plugin's principal.

The successful authentication result contains a server-selected `agentId`, an
explicit configured `policyRef`, and the policy fingerprint recorded at consent.
There is no default-role fallback. A missing role, missing explicit agent,
`sessions.others` other than `none`, a missing or permissive native tool
allowlist, or a policy-fingerprint mismatch fails closed. A code-execution
policy additionally requires `sandbox: required`; application-tools-only and
web-only policies do not require Docker. The application credential is admitted
only to this Responses endpoint;
it does not acquire reusable `operator.write` authority on other HTTP or gateway
methods.

## Native enforcement propagation

The host-created request principal carries:

- a stable `(pluginId, subject)` continuation identity, independent of access
  token rotation;
- the durable application profile used for session creator/owner comparison;
- the exact operator role definition named by `policyRef` as a request-local
  policy ceiling;
- the server-selected agent id;
- a trusted fresh-session creation stamp, including `sandbox: required` when the
  selected policy requires it.

Native Responses must pass that principal into create-on-run persistence. This
closes the current gap where first-turn authorization sees a profile but
`agentCommandFromGatewayIngress` persists no creator. Creator and sandbox are
stamped atomically on the new native session. Later turns use the existing
session-sharing checks; another application profile sees the session as someone
else's and is denied.

The request-local role must be consulted by native agent-selection and
session-sharing policy. Persisted `sandbox: required` remains immutable even if
the role later changes. The endpoint does not grant a native tool directly. For
the v0 Agent Connect profile, application tools are normalized as exact
`{ name, description, inputSchema }` records and any wire `strict` member is
rejected. This matches the pinned AI SDK adapter rather than synthesizing an
authority-changing default.

## Client-controlled fields

For an application principal the endpoint rejects, rather than trusts or
silently ignores:

- `x-openclaw-session-key` and body `user`;
- `x-openclaw-agent-id` and any agent-selecting model other than the fixed
  `openclaw/default` alias;
- `x-openclaw-model` and `x-openclaw-message-channel`.

The host generates the first canonical session key. Continuation uses only
`previous_response_id`, scoped to the stable application principal, selected
agent, and generated session. Supplying an unknown or cross-principal previous
response id is an authorization error, not a request for a fresh session.

This matters during token refresh: hashing the bearer, as the stock endpoint
does, loses continuity when the token changes. Conversely, keying only by client
id would let a new grant inherit a revoked grant's conversation. The grant id is
the stable subject.

## Capabilities and policy fingerprint

OpenClaw 2026.9.1 operator roles limit scopes, allowed agents, access to others'
sessions, and required sandboxing. They do not express fine-grained native tool
grants. Therefore the minimum safe deployment uses an operator-configured,
dedicated application agent selected by the grant. The v0 host helper accepts
only policies whose runtime meaning is unambiguous:

- application-tools-only uses an exact agent `tools.deny: ["*"]`; an empty
  `tools.allow` is not a deny-all policy in OpenClaw and is rejected without the
  wildcard deny;
- a native capability uses the exact agent allowlist mapped by the host
  (`web_search` for public web search, or `exec` and `process` for sandbox code),
  while provider-, profile-, sender-, and `alsoAllow` widening is rejected;
- global and sandbox policy layers must still admit every advertised native
  capability; the exact agent allowlist remains the upper bound;
- an isolated, non-personal workspace;
- no personal default workspace bootstrap;
- `sessions.others: none` in the named application role;
- `sandbox: required` when sandboxed code execution is approved.

`operator.write` must not be described as a web-search-only permission. The
plugin owns consent and durable grants; the native agent, role, session, and
sandbox machinery owns runtime enforcement.

The consent record stores a fingerprint computed by the same host helper used
at request time. It conservatively covers the named role definition, selected
agent configuration, effective agent defaults, and native tool configuration.
Any relevant configuration change invalidates the old grant and requires fresh
consent instead of silently broadening it.

## Owner authentication is separate

Owner authentication for the consent screen does not use the application-token
hook. The narrow
`authenticateManagedTailscaleOwnerConsent(request)` helper in
`openclaw/plugin-sdk/authenticated-http-principal` accepts the actual host
`IncomingMessage`. Listener dispatch binds the current auth configuration,
rate limiter, and config snapshot to that object; the helper then reuses native
managed-Serve WhoIs verification and durable profile/role resolution. It has no
ordinary HTTP or shared-secret fallback. The consent route is plugin-authenticated
so this helper, not generic gateway HTTP auth, owns only that route's admission.
The plugin must additionally require `operator.admin` and match the profile
against its configured owner allowlist, plus Origin and CSRF on POST.
Forwarded identity headers, a Tailscale-looking hostname, or network membership
alone are not proof. Ordinary HTTPS uses an independently supported owner login.

For v0 bootstrap, visit the native Control UI through managed Tailscale Serve so
its verified WebSocket login materializes the durable profile, then run
`openclaw users list --json` under the same isolated OpenClaw state directory to
obtain the profile id before enabling the plugin's `ownerProfileIds`. A live
WhoIs request remains a separate deployment gate; tests inject WhoIs only behind
the listener-owned managed-ingress provenance marker.

## Pinned validation contract

Against an isolated source build derived from `config/openclaw-test-compat.json`:

1. apply the recorded patch to OpenClaw 2026.9.1 and build a disposable package;
2. install it under a temporary prefix and point `OPENCLAW_TEST_BIN` at that
   binary; never mutate the live or personal OpenClaw install;
3. run deterministic local inference and a fixture plugin using the new seam;
4. prove two turns survive access-token refresh while a sibling principal,
   revoked token, stale policy fingerprint, altered tool snapshot, agent/model/
   session/header override, and cross-principal previous response id all fail;
5. inspect the native session row for the application profile creator and
   required-sandbox stamp; with sandbox unavailable, prove failure occurs before
   inference and no host command executes.

The patch handles browser CORS only for `/v1/responses`: bearer-free OPTIONS,
provider-approved exact Origin and headers, and CORS headers on subsequent
endpoint errors. It does not change global owner/admin CORS. The patch does not
itself solve durable Responses continuation across a gateway restart,
active-stream revocation, or owner-consent UX. Those remain separate acceptance
work and must not be inferred from this seam.

### Reproducible isolated build and smoke

Use the version and integrity recorded in `config/openclaw-test-compat.json` and
a Node version inside that file's supported range. Starting from an untouched
checkout of that exact OpenClaw release:

```sh
git apply --check <agent-connect-openclaw>/patches/openclaw-2026.9.1-application-principal.patch
git apply <agent-connect-openclaw>/patches/openclaw-2026.9.1-application-principal.patch
corepack pnpm install --frozen-lockfile
corepack pnpm build:package
corepack pnpm build:plugin-sdk:strict-smoke
OPENCLAW_TEST_BIN="$PWD/openclaw.mjs" \
  node --test <agent-connect-openclaw>/scripts/openclaw-application-principal.test.mjs
```

The strict plugin-SDK command must emit
`dist/plugin-sdk/authenticated-http-principal.js` and
`dist/plugin-sdk/openresponses-application-policy.js`. On the current pinned
checkout its final generic declaration checker reports an unresolved,
unclassified generated `agent-harness-runtime-*.d.ts` `__exportAll` issue; the two new
entrypoints are independently exercised by loading the compiled Agent Connect
plugin into the isolated host. Do not install this checkout over a personal or
live OpenClaw package.

### Two-stage managed-Serve deployment after owner approval

Keep machine paths and account identifiers in an ignored operator note. The
reproducible configuration uses placeholders and never copies subscription
tokens into Agent Connect:

1. Run the patched host with the Agent Connect plugin disabled, the existing
   subscription-backed model configuration unchanged, `gateway.bind: loopback`,
   `gateway.tailscale.mode: serve`, and `gateway.auth.allowTailscale: true`.
2. Visit the native Control UI through its managed Tailscale Serve URL. The
   verified WebSocket WhoIs login materializes a durable profile. On that same
   `OPENCLAW_STATE_DIR`, run `openclaw users list --json` and record only the
   returned profile id.
3. Configure a dedicated application role with `sessions.others: none`, the
   dedicated agent id, and no admin scope. Configure that agent with an explicit
   isolated workspace, `contextInjection: never`, the existing
   subscription-backed model reference, and `tools.deny: ["*"]` for the
   application-tools-only policy. Add only the exact host capability allowlist
   for a separately consented web or sandbox-code policy.
4. Configure the compiled plugin path, its durable grant-state path, exact HTTPS
   issuer/resource, the recorded `ownerProfileIds`, and the role/agent policy.
   Restart the patched host in managed Serve mode. The public client still sends
   only `model: "openclaw/default"`; the verified grant selects the dedicated
   agent server-side.
5. From the real owner device, approve fresh consent. Then run the Bookhand
   source lookup, application-tool result, contextual follow-up, and persistence
   acceptance flow. This live WhoIs/subscription gate requires explicit owner
   approval and is not authorized by the isolated tests above.

Ordinary HTTPS owner login is deferred in v0. Do not replace managed-Serve
provenance with forwarded identity headers, expose the shared gateway operator
secret to Bookhand, or mutate a running personal gateway as part of preparation.
