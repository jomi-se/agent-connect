# Scoped proxy to stock OpenClaw: implementation plan

Date: 2026-09-07. Branch: `work/openclaw-scoped-proxy`.
Parent checkpoint: `037e30c` on `work/openclaw-gateway` preserves the native
extension experiment. This plan selects a different execution boundary on this
branch; it does not assert the parent patch has completed independent review.

## Goal and settled boundary

Let an application obtain owner-approved scoped credentials through our existing
OAuth/PKCE flow, then use the existing browser SDK/AI SDK against a constrained
Responses proxy. The proxy privately operates **unmodified pinned OpenClaw**.
OpenClaw owns agent execution, subscription authentication, native tool policy,
sandboxing, context, and Responses events. We own app authentication, exact
request construction and app/grant conversation isolation. Do not recreate a
Responses engine or an agent runtime.

The app is untrusted; the installed proxy and operator configuration are trusted.
The upstream operator credential is never supplied to a browser. Tailnet access
is reachability, not owner authorization. Preserve verified identity/CSRF/PKCE
boundaries; no owner-login shortcut to make a demo pass.

## Phase 1 — Prove the boundary before expanding implementation

- Use the published unpatched version/integrity in
  `config/openclaw-test-compat.json`, isolated state and deterministic inference.
  Explicitly prove tests are not accidentally using the patched local build.
- Establish that an operator-authenticated native Responses turn honors a
  configured dedicated agent's deny-all and closed native tool policies. Test
  owner-only/elevated paths that might defeat that ceiling. Verify required
  sandbox failure is fail-closed without a host command or model request.
- Inspect supported request/model/session routing and native continuation. Keep
  an exact source/test-backed forwarding contract; a model alias alone is not
  caller isolation.
- Choose the smallest practical stock owner-auth composition: reuse existing
  standalone gateway owner-auth/grant components where possible. A separately
  deployed HTTP proxy is allowed. Do not import patched principal helpers.
  For the Tailscale flavor, validate real ingress provenance and WhoIs via the
  existing trusted mechanism, not caller-supplied headers. If unavailable, add a
  secure explicit owner login using established project machinery, document the
  deployment tradeoff, and do not claim seamless Tailscale login. Stop and report
  if a genuinely new product/credential decision is required.

## Phase 2 — Compose a bounded proxy

1. Reuse `DelegatedGrantService`, OAuth/PAR/token/revoke/consent handlers and the
   existing public client contract. Decouple host identity and policy resolution
   with narrow internal dependencies, not broad new provider frameworks.
2. Expose only intentional discovery/OAuth/Responses routes. No catch-all proxy,
   admin routes, upstream catalog/config exposure, arbitrary URLs, or redirects.
3. Construct each upstream body and header set from an explicit allowlist.
   Validate sizes/types first. Select the fixed configured agent/model/channel
   server-side; never forward caller cookies, auth, forwarding/identity/scope
   headers, user/session keys or unknown routing fields. Handle conflicting
   headers and unknown request fields deliberately. Reject unsupported media
   inputs before URL fetching. Permit only the documented v0 Responses subset.
4. Verify active grant, resource, browser origin and exact approved client tool
   snapshot on every admission/continuation. Send the private operator bearer
   only to one configured loopback upstream. Disable redirect following and keep
   the credential out of errors, logs, SSE, and browser-visible metadata.
5. Bind observed upstream response IDs to grant instance, fixed policy, and
   conversation. Reject unknown/cross-grant continuations before any upstream
   request. Never use shared operator identity as proof of caller ownership.
   New grant never inherits revoked grant sessions; refresh preserves grant
   identity. No implicit newest-conversation adoption. Use bounded state and
   explicit expiry/restart semantics, not a new durable response ledger unless
   necessary. Protect in-flight mapping/cancellation races and avoid poisoning
   mappings from incomplete or conflicting upstream responses.
6. Stream native events without reimplementing them. Incremental bounded parsing
   may observe IDs/function names for ownership and approved-tool enforcement;
   reject an unapproved tool before publishing it. Preserve normal event shapes,
   UTF-8/SSE framing, terminal semantics, backpressure and useful redacted errors.
   Define nonstreaming behavior and ambiguous disconnects explicitly. Never
   replay a possibly admitted request/tool mutation automatically.
7. Dedicated policies remain preconfigured, not per-app deployments. Reuse the
   closed policy validator. Define how config changes invalidate grants and how
   the proxy establishes configuration matches the upstream actually running.
   No claim of an atomic native config snapshot fence without a real mechanism.
   A supported static supervised configuration with restart/reconsent is a valid
   bounded alternative; label external unmanaged live edits as unsupported if
   that is the only honest contract. Do not silently accept a mutable remote
   endpoint while advertising strong confinement.

## Phase 3 — Proof and handoff

- Isolated stock composition: owner consent -> token -> two native client calls
  with outputs -> final text -> same-conversation follow-up; refresh and revoke.
  Use actual SDK and deterministic inference, not mocked OpenClaw events.
- Attack checks: sibling grant response ID, agent/model/session/user overrides,
  scope/header escalation, changed tool catalog, leaked credential/redirection,
  malformed/oversized input and unavailable sandbox. Demonstrate rejection
  before upstream effects where claimed. Ordinary application handler errors
  should remain tool results, not terminate the proxy transport accidentally.
- Bounded continuation expiry/restart/disconnect cases. No generic exactly-once
  claim; record partial-effects risk rather than replay.
- Run focused tests during edits; format once, final relevant typecheck/build/
  aggregate checks via quiet runner. Reuse fixtures. No live subscription usage.
- Update ADR/current handoff and deployment docs for this branch, with a simple
  deployment recipe, private credential handling and stock binary provenance.
  Preserve parent patch artifacts as an alternative; exclude them from required
  proxy install/build/test path. Keep browser SDK contract compatible.
- Persistent checkpoints below must record actual changes, exact test results,
  outstanding gates and next action. No pushes or live deployment/restarts.
  The eventual real Bookhand owner-consent smoke is separate and not claimed
  from deterministic fixtures. Do not contact/change Bookhand until an API
  incompatibility or ready endpoint requires coordination.

## Status

- [x] Preserve native experiment and create child branch.
- [x] Write proxy-first implementation plan.
- [x] Stock operator/tool/sandbox feasibility proof.
- [x] Owner auth and policy/config ownership contract established.
- [x] Scoped request proxy and grant-bound continuation implemented.
- [x] Actual SDK/OAuth/stock runtime composition validated.
- [x] Documentation, focused review and final local checkpoint.

Implementation owner: Sol high-effort subagent; parent owns final review.
All live services, Tailscale configuration, personal credentials and deployments
remain untouched. No new external writes are authorized.

## Completion checkpoint — 2026-09-07

Implemented a standalone scoped-proxy build and launcher, explicit
enrollment-secret owner session, reused delegated OAuth/grants, strict request
construction, static full-config/policy fencing, bounded single-use continuation
registry, byte-preserving observed SSE/nonstreaming relay, redacted failures and
scoped cancellation. The preserved native extension and custom replacement
engine are absent from `build:scoped-proxy` and `verify:scoped-proxy`.

The stock proof also established two dependency details used by the
implementation: OpenClaw canonicalizes session keys to lowercase, and the native
Responses route authenticates before JSON parsing. Private session keys are
therefore generated as lowercase hexadecimal suffixes, while the setup `check`
can verify the exact bearer with a deliberately malformed request without
starting inference.

Passing commands, using the Node/OpenClaw pins under `/tmp` for this isolated
development run:

```sh
PATH=/tmp/agent-connect-openclaw-node/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
  OPENCLAW_TEST_BIN=/tmp/agent-connect-openclaw-2026-9-1/node_modules/.bin/openclaw \
  node --test scripts/openclaw-scoped-proxy-stock.test.mjs

npm test --workspace @agent-connect/gateway -- \
  scoped-proxy.test.ts scoped-proxy-policy.test.ts \
  scoped-proxy-continuations.test.ts
# 3 files, 12 tests passed

npm run typecheck --workspace @agent-connect/gateway
npx eslint packages/gateway/src/scoped-proxy \
  packages/gateway/src/connector-auth.ts packages/gateway/src/index.ts \
  packages/gateway/test/scoped-proxy.test.ts \
  packages/gateway/test/scoped-proxy-policy.test.ts \
  packages/gateway/test/scoped-proxy-continuations.test.ts \
  packages/gateway/test/scoped-proxy-openclaw.integration.test.ts \
  scripts/openclaw-scoped-proxy.mjs \
  scripts/openclaw-scoped-proxy-stock.test.mjs \
  scripts/openclaw-test-runtime.mjs

PATH=/tmp/agent-connect-openclaw-node/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
  OPENCLAW_TEST_BIN=/tmp/agent-connect-openclaw-2026-9-1/node_modules/.bin/openclaw \
  npm run verify:scoped-proxy
# focused tests, four stock fixture/provenance tests, actual stock composition,
# and the independent AI SDK stock test all passed

PATH=/tmp/agent-connect-openclaw-node/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
  OPENCLAW_TEST_BIN=/tmp/agent-connect-openclaw-2026-9-1/node_modules/.bin/openclaw \
  npm run verify
# complete repository regression gate passed
```

No source gate remains. The real supervised HTTPS/subscription/browser/Bookhand
composition is intentionally not run or claimed here; it requires separate
operator coordination and fresh owner consent.

## Runtime revision follow-up — 2026-09-07

The earlier local-file-only fence has been replaced with stock runtime evidence.
Startup now calls authenticated `config.get` through the published
`@openclaw/gateway-client`, validates the redacted resolved source, requires
`configRevisionHash === appliedConfigHash`, and includes the applied revision in
grant policy fingerprints. Every Responses admission repeats that RPC immediately
before reservation/upstream POST and fails closed for missing, unapplied or
changed revisions. Health and consent decisions also check it. The raw projected
`hash`, resolved revision and local file digest are deliberately not compared.

This remains explicitly non-atomic. It detects accidental drift but cannot stop a
trusted operator reconfiguration between the admission check and native
Responses handling. Controlled stop/change/restart/reconsent is the supported
lifecycle; no supervisor, CAS endpoint, hot reload or OpenClaw patch was added.
The supported JSON template is now field-closed at execution-affecting levels.

Focused checks completed during implementation:

```sh
npm run build:scoped-proxy
# passed

npm test --workspace @agent-connect/gateway -- \
  scoped-proxy.test.ts scoped-proxy-policy.test.ts \
  scoped-proxy-runtime-config.test.ts
# 3 files, 14 tests passed

PATH=/tmp/agent-connect-openclaw-node/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
  OPENCLAW_TEST_BIN=/tmp/agent-connect-openclaw-2026-9-1/node_modules/.bin/openclaw \
  npm run test:integration:openclaw --workspace @agent-connect/gateway
# 1 real stock composition test passed

npx eslint packages/gateway/src/scoped-proxy \
  packages/gateway/test/scoped-proxy*.test.ts \
  scripts/openclaw-scoped-proxy.mjs
# passed

PATH=/tmp/agent-connect-openclaw-node/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
  OPENCLAW_TEST_BIN=/tmp/agent-connect-openclaw-2026-9-1/node_modules/.bin/openclaw \
  npm run verify:scoped-proxy
# format/build; 4 focused files, 16 tests; 4 stock fixture tests;
# 1 stock SDK/OAuth composition; and 1 independent AI SDK composition passed

npm run typecheck --workspace @agent-connect/gateway
# passed
```

The first direct stock drift assertion sampled immediately after the disposable
file write and saw the previous revision. It was corrected to poll the real
Gateway for up to five seconds, matching its asynchronous file observation; the
bounded test then observed the changed saved revision and the proxy rejected it.
No model allowance, live credentials or non-loopback services were used.

## Admission and coexistence review follow-up — 2026-09-07

The final local admission fence now observes disconnects before request-body and
runtime-config waits, then checks disconnect state and rechecks grant authority
after `config.get` immediately before conversation reservation and upstream
dispatch. Barrier tests revoke or disconnect while runtime verification is
paused and prove zero new upstream effects; refused continuation admission leaves
the existing checkpoint available.

The policy validator now permits unrelated personal agents, model entries,
provider definitions and authentication profiles. It remains field-closed for
every policy-offered agent, each offered agent's selected model, and all inherited
agent/tool/plugin layers. Multiple policies may select distinct closed agents;
the grant remains the only app-visible routing choice. Unsupported conditional
tool layers on global or offered-agent policy still fail closed. The real stock
SDK/OAuth composition now calls the production policy validator against stock
`config.get`, closing the earlier partial-assertion evidence gap.

Focused closure evidence:

```sh
npm test --workspace @agent-connect/gateway -- \
  scoped-proxy.test.ts scoped-proxy-policy.test.ts
# 2 files, 16 tests passed

PATH=/tmp/agent-connect-openclaw-node/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
  OPENCLAW_TEST_BIN=/tmp/agent-connect-openclaw-2026-9-1/node_modules/.bin/openclaw \
  npm run test:integration:openclaw --workspace @agent-connect/gateway
# 1 real stock composition test passed

npm run typecheck --workspace @agent-connect/gateway
npx eslint packages/gateway/src/scoped-proxy/policy.ts \
  packages/gateway/src/scoped-proxy/server.ts \
  packages/gateway/test/scoped-proxy.test.ts \
  packages/gateway/test/scoped-proxy-policy.test.ts \
  packages/gateway/test/scoped-proxy-openclaw.integration.test.ts
# passed
```

No aggregate verification suite was repeated: the focused build, runtime,
stock-composition and repository gates recorded above already cover the unchanged
surface. Profile suggestion/application remains unimplemented advisory future
work, documented in the deployment guide as an explicit operator-approved
`config.schema.lookup` / `config.get` / `config.patch` flow.
