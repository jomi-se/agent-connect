# OpenClaw application-principal patch proposal hardening

Status: implementation and pinned validation complete; awaiting review.

## Scope

Harden the minimum host seams needed for a plugin-issued application principal to
use native `/v1/responses` without becoming an operator. Keep OAuth, consent,
Agent Connect capability vocabulary, and the app-only deployment recipe in the
plugin. Preserve native Responses execution and the pinned, reproducible combined
patch; do not claim current-upstream compatibility or maintainer acceptance.

## Settled design

- Core exposes one experimental, endpoint-scoped delegation provider.
- Authentication returns a plugin-namespaced nonhuman subject plus an opaque
  plugin policy reference and revision. Core binds the registering plugin and its
  lifecycle generation; neither is supplied by the caller.
- Plugin authorization receives the parsed request, including media and exact
  client-tool shapes, before any remote media resolution or native session/run
  effect. Agent Connect owns the fixed-tool, strict/media, and capability recipe.
- Native admission is the linearization point: after plugin authorization and
  immediately before principal/session resolution, core verifies the registration
  is still current and resolves the referenced host execution policy. The admitted
  run receives that immutable resolved ceiling; runtime preparation must not
  resolve a newer agent policy for this run.
- Plugin retirement or policy revision before admission denies the request.
  Retirement/revocation after admission does not actively cancel the run; it only
  prevents later admissions/continuations.
- Durable storage may reuse native profiles internally, but records an application
  identity kind and plugin/subject provenance. Subjects are grant-instance IDs and
  must never be reused after deletion; retained identities/sessions are tombstoned
  audit data, not operator logins. The plugin retains owner-consent audit ownership.
- Core exposes a generic listener-bound verified HTTP principal helper with an
  explicit accepted-auth-method constraint. Tailscale WhoIs, owner allowlisting,
  Origin, CSRF, and consent stay plugin-owned.

## Checkpoints

- [x] Read repository guidance and the clean architectural review.
- [x] Trace native authentication-to-admission and runtime config boundaries.
- [x] Repair registry rollback, plugin scope, and lifecycle-generation fencing.
- [x] Move Agent Connect request/capability recipe out of exported core types.
- [x] Bind a host-resolved immutable policy ceiling to native admission/execution.
- [x] Record honest application provenance in durable session creation state.
- [x] Generalize the verified-request-principal helper and retain WhoIs assurance.
- [x] Regenerate the bounded patch from tracked reconstruction changes only.
- [x] Run focused deterministic tests and real pinned disposable composition.
- [x] Run formatter once, then final aggregate verification and diff review.

## Review findings addressed

| Finding                     | Resolution                                                                                | Evidence                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A1 policy/admission race    | Revision/generation fence at admission plus immutable host-resolved ceiling               | Config-change and provider-retirement tests; captured config reaches native preparation  |
| A2 product policy in core   | Opaque policy reference/revision in core; Agent Connect recipe/request policy in plugin   | No Agent Connect capability names in core; plugin recipe and request-policy tests pass   |
| A3 human attribution        | Nonhuman application creator plus internal profile ownership key and documented retention | Real SQLite row inspection checks plugin, stable subject, profile key, and sandbox stamp |
| D1 failed-registration leak | Owned registration rollback                                                               | Register-then-throw test permits a replacement provider                                  |
| D2 stale callbacks/scope    | Plugin callback scope plus lifecycle-generation admission fence                           | Callback-scope and retired-generation tests pass                                         |
| Owner HTTP auth coupling    | Generic verified-principal method constraint; consent policy remains plugin-owned         | Managed-listener provenance test and compiled consent composition pass                   |

## Test record

All runtime tests used deterministic fixture inference; no paid model calls or
personal credentials were used.

- `npm run format:check`: pass.
- Gateway typecheck, build, and aggregate tests: pass. Aggregate test log:
  `/tmp/agent-connect-command-logs/quiet-run.hzrUoE.log`.
- Agent Connect OpenClaw plugin build and focused policy/OAuth tests: pass.
- Patched OpenClaw `pnpm tsgo`: pass.
- Patched OpenClaw focused gateway/plugin tests: pass (policy revision,
  config-change and retirement admission, provider scope, registration rollback,
  verified-principal provenance).
- Patched OpenClaw format check: pass; log
  `/tmp/agent-connect-command-logs/quiet-run.uOfDki.log`.
- Patched OpenClaw `build:package`: pass; log
  `/tmp/agent-connect-command-logs/quiet-run.QvzAJc.log`.
- `build:plugin-sdk:strict-smoke`: build and new JS/declaration entrypoint emission
  pass, but the final checker fails on the pre-existing generated
  `dist/agent-harness-runtime-Bt9gI0WW.d.ts` undeclared `__exportAll`; log
  `/tmp/agent-connect-command-logs/quiet-run.6lOrVH.log`.
- Full TypeScript compiler attempts exceeded both 4 GiB and 8 GiB heaps. Fast
  `tsgo` is clean; logs `/tmp/agent-connect-command-logs/quiet-run.zuoUQH.log`
  and `/tmp/agent-connect-command-logs/quiet-run.Up3exw.log`.
- Real pinned application-principal composition: pass, including stock auth
  pass-through, claimed-invalid denial, no-fetch request denial, two-turn token
  rotation, cross-grant isolation, stored application creator, and
  sandbox-unavailable fail-closed before inference; log
  `/tmp/agent-connect-command-logs/quiet-run.SYnQpL.log`.
- Compiled Agent Connect consent plugin against the patched host: pass; log
  `/tmp/agent-connect-command-logs/quiet-run.4JzgrJ.log`.
- Regenerated patch applies cleanly to a fresh local baseline, has no whitespace
  errors, and its resulting tracked diff is byte-identical to the expanded source.

## Remaining risks

- The source mirror is a reconstruction at local baseline
  `7bf7fde3f6a46c9d7d93ddbf1d965b8cbcd0db1f`; published-package provenance is
  pinned separately by `config/openclaw-test-compat.json`.
- Native response-ID continuation remains process-local and fails after restart or
  eviction. This work does not add a durable continuation engine.
- No active cancellation on credential revocation, plugin retirement, or policy
  change after native admission.
- Optional sandbox/web capabilities remain unclaimed unless real pinned-runtime
  confinement tests pass.
- The strict SDK declaration checker and full `tsc` resource ceiling above remain
  validation limitations, not green gates.
