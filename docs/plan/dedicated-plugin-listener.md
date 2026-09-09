# Dedicated listener for the OpenClaw proxy plugin

Date: 2026-09-09. Status: implemented through the owner publication gate; no
package publication, live service, credential, or ingress change performed.

## Decision and outcome

Agent Connect remains an installed OpenClaw plugin, running in the same process
and owned by its service lifecycle, but listens on its **own loopback HTTP port**.
It no longer mounts application routes on OpenClaw's native HTTP listener.

```text
Phone / third-party application
  -> tailnet HTTPS :443
  -> TLS-terminated forwarding to loopback :18790
       Agent Connect listener (plugin-owned)
       consent, discovery, scoped Responses, history, cancel
          -> authenticated loopback HTTP/RPC :18789
               native OpenClaw gateway and agent execution

One OpenClaw process owns both listeners.
No separately operated Agent Connect executable or daemon.
```

Whole-port forwarding to **the correct plugin port** can no longer expose the
native control UI, terminal, native Responses or administrative endpoints, because
that listener has no such handlers. This improves the default deployment boundary.
It is not process isolation: installed host plugins and local operator processes
remain trusted. Forwarding the wrong native port can still expose native routes;
keep native authentication and configuration checks as defense in depth.

Default proposal: native OpenClaw18789, Agent Connect18790. The plugin port is
explicitly configurable for existing hosts; don't assume their native port.
Binding is fixed to IPv4 loopback127.0.0.1 for v0, not configurable to all interfaces.
No port auto-increment, fallback to native mounting or silent alternate listener.

## Preserve existing behavior

- Keep public provider address and `/agent-connect` namespace unchanged, including
  both RFC well-known discovery URLs. Public origin is independent of local port.
- Reuse the current request handler, auth/grants, policy confinement, headers,
  streaming, cancellation and conversation registry. Do not reconstruct a second
  engine or reintroduce the deleted standalone gateway package/scripts.
- Native OpenClaw still owns subscription authentication, tools/model execution,
  context, agent sessions and its own listener. Plugin retains internal native
  auth resolution; no owner credential reaches the browser.
- Preserve owner login/CSRF/Origin/PKCE checks and fixed approved tool snapshots.
- No new SDK/Bookhand protocol or address-path changes expected. Same externally
  visible issuer/resource does not require a credential migration feature.
- Owner has chosen fresh deployment, no old credential/grant migration. A plugin
  restart still discards process-local continuation authority; don't replay it.

## Current source map

Baseline at authoring: `561bb26`, after guided setup and cancellation/id fixes.
Read current AGENTS and status before implementation; concurrent work may continue.

- `packages/openclaw-plugin/src/index.ts`: three `api.registerHttpRoute` calls,
  service start/stop, native readiness, CLI setup/doctor.
- `src/runtime/handler.ts`: `createAgentConnectHandler`, asynchronous
  `handle(IncomingMessage, ServerResponse)` and `close()` already separate HTTP
  behavior from native host registration. Reuse this seam.
- `src/config.ts`, `openclaw.plugin.json`, `src/host-api.ts`: plugin config,
  inspection and public host API types. Add only the required listener setting.
- `src/readiness.ts`: recent abort-before-runtime-check fix; retain it.
- `scripts/openclaw-plugin-host-stock.test.mjs`: real installed-plugin OAuth,
  tool/result/follow-up/history and lifecycle fixture; adapt rather than duplicate.
- `docs/decisions/0015-openclaw-plugin-host.md` and
  `docs/architecture/stock-openclaw-plugin.md`: earlier shared-listener design
  must be updated explicitly when implementation lands.
- Artifex `/home/dev/artifex-box/config/openclaw/openclaw.json` is actual
  Git-owned host/plugin config. `config/tailscale/serve.json` and its supported
  apply script are generic ingress infrastructure, not plugin code.

## Phase 1 — Prove the lifecycle seam

Use public `registerService` with a plugin-owned Node HTTP server in a disposable
installed stock OpenClaw instance. Verify it can bind/start/stop without requiring
an undocumented host API or blocking native gateway startup. Do not infer service
ordering: current native readiness is deferred because native HTTP may start later.

Show two distinct ports in the same process; native listener remains usable to
its fixture operator, plugin listener rejects unauthenticated app requests, and
plugin disable closes only the plugin listener. Use deterministic inference or
no inference for this probe. No changes to the personal VM runtime or ingress.

## Phase 2 — Replace mounting with a bounded HTTP listener

1. Add validated `listenPort` (proposed name) to the plugin config/manifest,
   setup preview/apply and doctor. Accept integer1..65535, default18790 when
   absent; reject equality with the configured native port. Artifex commits it
   explicitly. Don't put it into the public OAuth resource or model policy.
2. Add a small listener module owning `http.Server` and socket cleanup, or keep
   it local if genuinely simpler. Bind127.0.0.1 and await the bind result before
   reporting local listener success. Handle `EADDRINUSE`/permission errors with
   actionable sanitized diagnostics; never kill the occupying process.
3. Remove all native `registerHttpRoute` registrations for Agent Connect. Do not
   leave aliases on the native port: that would preserve the deployment footgun.
   Update manifest capability metadata if the pinned host requires it, based on
   its actual published API—not invented permission names.
4. Route only exact supported metadata and the intended plugin subtree into the
   existing handler. Unknown paths receive a local404, including `/`, `/terminal`,
   `/openclaw`, native `/v1/responses`, arbitrary RPC and unknown discovery paths.
   No catch-all upstream proxy, filesystem serving, CONNECT or WebSocket tunnel.
   Explicitly close unsupported upgrades/CONNECT requests rather than leave
   unowned sockets hanging. Apply normal HTTP server timeout/header protections
   without imposing an arbitrary short timeout on legitimate SSE response bodies.
5. Requests before native readiness return bounded503 only on plugin routes;
   unknown routes remain404. Service start must not deadlock waiting for native
   HTTP. Keep the native authenticated configuration/readiness checks.
6. Handle async dispatcher errors explicitly; Node's HTTP callback does not await
   a returned Promise. Preserve existing safe pre-/post-header error handling;
   no unhandled rejection or secret-bearing internal exception in responses.
7. On stop: prevent new admissions, stop accepting connections, abort native
   readiness, close handler-owned work and release sockets with bounded graceful
   shutdown. Active SSE/keep-alive clients must not hold reload forever. Close
   only sockets belonging to this listener, never the native host's server.
   Clean up partially initialized resources on bind/readiness failure.
8. Restart/re-enable must bind the same port successfully with no duplicate
   server, lingering timers or stale active-service reference. Port/config changes
   require the normal supported host reload/restart; don't implement an independent
   hot-reload manager.

## Phase 3 — Setup and diagnostics

- Guided setup explains “OpenClaw native port” vs “application access port” once;
  existing valid settings are defaults, not questions to repeat on every run.
- Doctor distinguishes valid configuration, listener available, native upstream
  ready, and public ingress pending. Config inspection alone cannot claim live
  readiness. Probe only the intended local plugin port without a model call.
- Final success displays the public provider URL and local forwarding target,
  explicitly warning not to forward the native port for third-party app access.
- Preserve native token/password/no-auth support as generic plugin compatibility;
  Artifex's fresh native authentication remains a separate concern. Do not silently
  switch to no-auth to make readiness pass.
- Retain native OpenClaw lifecycle ownership. No new `agent-connect serve` process,
  tmux controller, systemd unit or supervisor is introduced by this change.

## Phase 4 — Artifex and Tailscale integration

Coordinate with the active Artifex agent. Keep all durable settings in its repo:

1. Add explicit `listenPort:18790` to the tracked plugin config; leave native
   OpenClaw loopback18789. Preserve model, agent profile and secret separation.
2. Replace the three old routes targeting native18789 with one TLS-terminated TCP
   route targeting127.0.0.1:18790 on public443, using the already supported Artifex
   route schema. This forwards HTTP unchanged and avoids adding proxy identity
   headers that the current handler deliberately rejects. No new transport code.
   HTTPS path routing to18790 remains a possible operator alternative; don't
   weaken header/identity checks broadly to support it without a concrete need.
3. Treat this as a reviewed ingress-mode transition, not a normal no-op apply.
   The generic Artifex plan must show removal of the old443 handlers and creation
   of the new listener. Preserve every unrelated port/preview. No Serve reset,
   Funnel, ACL changes or passwordless operator assignment.
4. Update installer version pins after the plugin release exists. No local
   tarball/archive fallback. Plugin package version bump and lockfile belong with
   implementation; Jose pushes and publishes through existing release workflow.
5. Update operator docs so native routes are absent by construction on the app
   listener, not merely hidden by a correctly configured reverse proxy. Include
   the remaining risk of selecting the wrong port and of trusted local code.

No live route/service changes during implementation. Owner explicitly approves
publication and then deployment; obtain sudo normally. Do not route to18790 until
the fresh published plugin is ready there. Report any change to public origin
separately because that would require fresh consent; keep it unchanged here.

## Phase 5 — Focused evidence

Extend existing installed-stock fixture to discover and use the **plugin port**.
Keep one real host with two listeners and deterministic inference:

- Run existing consent -> two tool/result segments -> follow-up/history ->
  refresh/revoke through the dedicated listener. Current SDK works unchanged.
- On plugin listener, native UI/terminal/API/RPC paths and unsupported upgrades
  fail without reaching native OpenClaw. Include trailing slash, prefix-boundary
  and encoded-path cases relevant to the actual handler; no giant fuzz project.
- On native listener, Agent Connect routes are not mounted. Native host routing
  may have its own UI fallback, so assert absence of plugin responses rather than
  assuming every unknown native path necessarily returns404.
- Native auth still protects operator functions; app bearer isn't operator auth.
- Port occupied: plugin reports failure, no alternate exposure, occupying service
  untouched, native OpenClaw unaffected as far as the host API permits.
- Disable during readiness, disable with an open SSE stream, then re-enable:
  no post-abort readiness RPC, no leaked listener and same-port reuse succeeds.
- Preserve existing request-size/header/auth constraints; binding loopback is
  asserted. Don't treat in-process fixtures as proof of real host lifecycle.

Run relevant plugin/type/package checks, the adapted stock fixture, and Artifex
syntax/smoke. Quiet output, no paid model checks or repeated whole-repo matrix.
After owner deployment, verify public discovery, unauthenticated rejection and
native-path404 on the exposed listener. Then owner confirms a Bookhand prompt,
tool call and follow-up/reload. No agent consent approval or uncertain replay.

## Completion and handoff

Update the earliest architecture/ADR/deployment sources, not contradictory new
instructions alongside the old shared-listener recipe. Record this as a change
to the accepted installation design, not a new standalone proxy product.
Generic Tailscale tooling stays in Artifex; application SDK stays unchanged.

Commit bounded units: listener/config/lifecycle with tests; architecture/setup
docs and package bump; Artifex config/docs/pin once published. No automatic push.
Keep ledger updated and state what is synthetic, installed-host, or owner-live
evidence. An inability to bind/manage a service through the public host lifecycle
is an escalation point, not permission to introduce another daemon or core patch.

Implementation record, 2026-09-09:

- The plugin now owns a bounded `127.0.0.1` listener, removes native route
  registration, validates `listenPort`, reports live listener/native readiness,
  and logs the explicit no-auth native-port bypass warning.
- The pinned OpenClaw 2026.9.1 public service lifecycle, loopback callback server,
  and gateway shutdown code were inspected for startup failure ownership, bind
  behavior and bounded socket cleanup. CI/deployment retain that exact evidence
  pin, while the published plugin admits OpenClaw 2026.9.1 or newer without a
  speculative compatibility matrix or upper bound.
- Unit evidence covers route boundaries, encoded paths, async errors,
  upgrade/CONNECT rejection, occupied-port refusal and same-port reuse. The
  installed-stock fixture proves two same-process listeners, full deterministic
  OAuth/tool/history composition through the plugin port, absence from the native
  listener, open-stream disable/re-enable and an occupied plugin port that leaves
  native OpenClaw usable. No subscription inference was used.
- npm publication completed for plugin `0.0.2` and SDK `0.0.4`. Artifex commit
  `fce2ab9` pins the published plugin version and integrity, commits
  `listenPort: 18790`, and declares whole-port TLS forwarding only to that
  dedicated listener. Its reviewed transition retires the exact old shared-port
  handlers or demo forward before adding the new route and refuses drift.
- Artifex smoke checks and a disposable fresh-target install pass with exact
  OpenClaw `2026.9.1` and plugin `0.0.2`. The actual user-local profile has the
  same plugin and reconciled receipt. Read-only live Serve planning reports one
  exact demo-forward removal, one dedicated-listener addition, and zero
  conflicts; no route was applied because `18790` is not listening before owner
  setup/startup.
- Final local checks pass: plugin typecheck/unit/build, release logic,
  installed-tarball smoke, formatting, and the five-case installed stock-host
  suite. The prepared plugin tarball SHA-256 is
  `8940924761b40ad25dcf6af38038df68e1d166d12db9bdccc8feb9c7c59a02cf`.

Ledger:

- [x] Dedicated-listener product direction accepted; current source inspected.
- [x] Same-process service/listener seam proved on pinned stock host.
- [x] Native mounting removed; dedicated server/config/lifecycle implemented.
- [x] Existing composition and negative/lifecycle checks pass.
- [x] Artifex configuration, runbooks and exact plugin pin updated atomically
      after `@open-agent-connect/openclaw-plugin@0.0.2` publication.
- [x] Owner npm publication and fresh Artifex package-install proof.
- [ ] Owner login, gateway startup, ingress apply and public isolation proof.
- [ ] Owner Bookhand flow confirmation and final clean handoff.

## Deferred review follow-ups

Owner decision, 2026-09-09: neither item below blocks publication or the Artifex
update. Keep the existing behavior for this cutover; these are bounded technical
debt tasks, not additional deployment gates.

- [ ] Exclude local `listenPort` from the delegated-policy fingerprint in
      `packages/openclaw-plugin/src/config.ts`. Changing only the private listening
      port currently invalidates grants even when the public origin and permissions
      remain unchanged. Preserve invalidation for public-origin or policy changes.
      Add a focused regression asserting that a port-only change preserves the
      fingerprint. Until then, a port change may require reconnecting and consent.
- [ ] Tighten doctor readiness identification in
      `packages/openclaw-plugin/src/index.ts`. A stale service returning HTTP 200 on
      the configured health path can be mistaken for the intended instance. Consider
      checking non-secret provider/config identity, with one wrong-identity test.
      This is diagnostic accuracy, not an authorization bypass: occupied-port startup
      already fails. Avoid introducing a general instance-management subsystem.
