# OpenClaw plugin-host implementation

Date: 2026-09-08. Branch: `work/openclaw-plugin-host`, based on `3cc49ec`.
Status: implementation authorized; live cutover, publication and push excluded.
Decision: [ADR 0015](../decisions/0015-openclaw-plugin-host.md).

## Outcome and ownership

A user with an existing OpenClaw installation installs one Agent Connect plugin,
runs owner-approved setup, and connects an application. OpenClaw hosts and stops
the feature. No separately operated Agent Connect process, second OpenClaw
deployment, core patch, global credential migration or new agent engine.

Root owns architecture, review and escalation. One Sol implementation lane owns
the code, focused tests, packaging, implementation documentation and milestone
commits on this branch. It is not alone in the workspace: preserve others' edits,
stage only owned changes, and never revert unrelated work. Do not create extra
worktrees or fan out agents. Bookhand belongs to CDX2; send a concrete SDK handoff
to root, do not edit Bookhand or instruct a live cutover independently.

## Settled constraints

- Reuse the existing scoped proxy engine; do not fork its security logic into a
  second implementation or revive the historical patched plugin entry point.
- Native OpenClaw performs execution, policy enforcement and Responses event
  production. Forwarding is internal to the plugin using host-held authority.
- Fixed approved tool declarations on every segment; private routing fields and
  operator credentials never pass through from/to applications.
- Preserve Origin/PKCE/PAR, rotating refresh, revocation, admission fences, native
  output inspection, no automatic replay, and bounded in-memory history.
- Personal agents and unrelated configuration survive install/setup/uninstall.
- A restrictive configuration that refuses unsafe access is acceptable; silently
  changing a user's global settings or declaring every configuration safe is not.
- No model allowance, live credentials, live services, Tailscale, Funnel, public
  deployment, npm publication, git push or merge during implementation.

## Source map and existing evidence

- `packages/gateway/src/scoped-proxy/server.ts`: `createScopedResponsesProxy`
  owns the HTTP server as well as handlers; extract the handler/lifecycle seam.
- `scoped-proxy/{request,continuations,history}.ts`: proven mediation; keep it.
- `scoped-proxy/{config,policy,runtime-config}.ts`: deployment-specific config,
  whole-file/applied-revision checks and private RPC client.
- `packages/gateway/src/{delegated-grants,connector-auth}.ts` and
  `openclaw-plugin/{oauth-handler,oauth-utils,consent-html}.ts`: reusable auth.
- `openclaw-plugin/index.ts` imports patch-only host exports. It is historical,
  NOT the stock plugin starting point; neither it nor its ambient host type shim
  may enter the new published package's dependency graph.
- `packages/web-sdk/src/openclaw-connection.ts` validates a root-origin issuer
  and hardcoded root resource; namespaced discovery needs an explicit update.
- `scripts/openclaw-test-runtime.mjs` supplies isolated real pinned OpenClaw,
  disposable state and fake inference. Existing scoped integration tests provide
  the OAuth/tool/history scenarios to reuse, not duplicate wholesale.
- `config/openclaw-test-compat.json` is the compatibility pin. Use installed stock
  package declarations/docs as the oracle, not latest online APIs blindly.

Prior disposable probe (not production code): `registerService`,
`registerHttpRoute({auth:"plugin",match:"exact"})`, startup activation, and
`api.runtime.config.current()` worked on stock 2026.9.1. The route forwarded to
the SAME gateway's `/v1/responses` with server-owned auth/routing, relayed native
SSE, and completed a client function-output continuation. Missing app auth and
using the app token at native Responses both returned 401. The initial readiness
check preceded plugin availability; wait for plugin readiness, not only health.

## M1: Extract and package the actual plugin

1. Extract reusable request handling and shutdown from the server wrapper while
   retaining the standalone wrapper as baseline. Keep one implementation of
   security-sensitive routing, grants and continuation inspection.
2. Add a distinct stock-plugin package/entry with `openclaw.plugin.json`, compiled
   ESM entry, explicit startup activation, config schema, runtime dependencies
   and tested host-version compatibility. Prefer focused host SDK imports/types.
3. Register plugin-owned routes on OpenClaw's existing listener and a managed
   service for state initialization/cleanup. Service start must not deadlock by
   awaiting a native endpoint that starts only after the service; use bounded
   readiness and return unavailable until safe to serve.
4. Native `/v1/responses`, owner dashboard, health and other plugins remain
   untouched. No catch-all root handler, route replacement or auth bypass.
5. Persist identity/grants in plugin-specific host state; keep conversation
   authority process-local. On stop/reload refuse new admissions, abort/drain
   owned streams, remove timers/listeners and discard stale in-memory authority.
6. Keep the operator credential internal, derive it from supported resolved host
   configuration in the supported auth mode. Do not copy subscription auth,
   expose config values, or dispatch untrusted request fields through host RPC.
   Diagnose unsupported password/SecretRef/auth modes rather than invent fallback.

Checkpoint: installed real plugin starts, exposes only its namespace, rejects
unauthenticated app calls, and stops its owned work. Root gets source/risks.

## M2: Namespaced discovery and client compatibility

1. Use a scoped endpoint such as `/agent-connect/v1/responses`, not native root
   Responses. Centralize endpoint layout instead of scattering string rewrites.
2. Settle exact issuer/provider-base, OAuth metadata, protected-resource metadata
   and route layout BEFORE coding SDK changes. For a path-based issuer use the
   standard well-known construction, not a newly invented discovery convention.
   Verify pinned native routes do not already own any intended path. Send root
   the short endpoint table; a namespace change is not permission to relax URL
   validation or follow arbitrary metadata redirects.
3. SDK supports the verified plugin layout with HTTPS/same-origin/path binding;
   keep existing standalone layout working unless an explicit migration decision
   replaces it. Bind pending authorization, token audience and callback identity
   to the actual issuer/resource; reject mixed old/new discovery and tokens.
4. Preserve generic AI SDK provider construction and existing connection,
   refresh, revocation and conversation APIs. No OpenClaw types in browser APIs.
5. Root supplies the tested tarball/provenance and required URL change to CDX2.

## M3: Safe setup and coexistence (hard gate)

1. Inventory exact current validator assumptions before editing: it currently
   restricts gateway keys, token auth, reload mode, global tools/defaults, memory
   slot and plugin entries. In particular it rejects any additional plugin.
2. Separate whole-installation assumptions from effective offered-agent policy.
   Keep strict checks for anything capable of expanding app execution authority.
   Read the supported active runtime snapshot, not merely a file that may differ
   from the running gateway. Do not use private host internals to claim safety.
3. Provide an operator-only setup/doctor command. Default is inspect/preview;
   applying changes requires explicit owner action. Use supported config mutation
   and conflict/reload semantics. Add namespaced agent IDs/workspaces/plugin
   settings and necessary Responses enablement. Preserve references, arrays,
   unrelated agents/channels/plugins and credentials; never silently overwrite an
   existing conflicting ID. Repeat setup is idempotent.
4. Validate inherited native-tool ceilings, elevation, memory/context injection,
   skills and sandbox settings. Native code execution requires the existing
   confined sandbox guarantees. Do not globally disable the user's memory or
   tools. If a required restriction cannot be applied per agent with public APIs,
   report the precise limitation to root; do not silently weaken the grant or
   launch a hidden second OpenClaw service.
5. Other plugins are host-trusted code, not an isolation boundary. Establish which
   global hooks/policies can affect offered agents. Support known-safe coexistence
   with evidence and report unsupported combinations precisely. Do not certify
   arbitrary loaded plugin behavior from a JSON allowlist alone.
6. Define relevant runtime-policy fingerprinting and change handling. Unrelated
   personal changes should not invalidate grants unnecessarily. A relevant change
   must prevent further unsafe admission/continuation. Same-process snapshot reads
   plus subsequent internal HTTP are NOT an atomic native admission fence; retain
   the trusted-operator reconfiguration limitation and prove supported reload
   behavior. If safety needs a new core hook, escalate rather than smuggle a patch.
7. Preserve current explicit owner login/CSRF protection. Tailscale headers alone
   are not an owner session. No native owner-auth integration expansion in this
   slice. Setup must explain how the owner obtains initial access without storing
   or logging reusable plaintext passphrases.

Checkpoint: publish exact supported configuration matrix and incompatible cases.
If ordinary existing installs require intrusive global changes, STOP and report;
this milestone is not satisfied by the synthetic minimal config alone.

## M4: Focused real-package validation

- Install the packed artifact into disposable stock OpenClaw using its supported
  package install path; source-checkout success alone does not prove packaging.
- Exercise existing owner login -> consent -> SDK -> two tool/result segments ->
  follow-up/history -> refresh/revoke through the PLUGIN endpoint, with fake
  inference and native Responses. Confirm tool ceilings at actual model boundary.
- App token fails at native Responses/admin RPC; unapproved tools and app routing
  controls cannot escape to upstream. Keep native root endpoint functional for an
  actual fixture operator; coexistence is not taking over the root route.
- Personal agent/channel configuration survives setup, rerun and plugin disable;
  relevant unsafe inherited configuration fails before inference. Include at
  least one representative non-minimal personal setup, not only an empty gateway.
- Service disable/restart closes active work and invalidates process-local heads;
  stale continuation is never silently replayed. Exercise a relevant config-change
  case and record the remaining trusted-operator race boundary honestly.
- Reuse deterministic state fixtures for AC-owned faults, real stock for host
  behavior. No mock OpenClaw event streams. One focused browser/package CSP gate
  if SDK/bundling changes touch that boundary; no broad browser matrix.
- Use `quiet-run.sh`; detach slow checks, keep failure tails bounded. Narrow tests
  during edits, formatter once at stabilization, final relevant gates once.

## M5: Documentation, review and handoff

Update supported setup and earliest sources of truth when implementation is
verified: AGENTS, mission, current-work, SDK/provider docs and deploy guidance.
Do not claim a live migration or delete historical evidence/working launchers.
Ship installation, setup preview/apply, doctor, upgrade/disable behavior, known
incompatibilities and recovery limits. No personal hostnames or secret paths.

Commit coherent milestones locally. Final report: commits, package install
command/artifact and hash, exact supported configurations, changed SDK endpoints,
test evidence, known limitations, and owner actions required for a later cutover.
Root reviews implementation and test evidence before merge or live rollout.

## Persistent implementation ledger

- [x] Target architecture accepted; branch created from clean main.
- [x] Stock plugin HTTP/service/native Responses seam probed independently.
- [ ] M1 packaged plugin hosting and lifecycle.
- [ ] M2 verified namespace/discovery and SDK compatibility.
- [ ] M3 safe existing-install coexistence and setup.
- [ ] M4 real installed-package composition and negative tests.
- [ ] M5 documentation, root review and owner handoff.

Update this ledger at meaningful checkpoints and before any pause. Record failed
approaches and exact blockers briefly so another provider can resume without
reconstructing the conversation.
