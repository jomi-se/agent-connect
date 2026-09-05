# OpenClaw replacement: scope, contract and progress

Status: investigation complete enough for shared policy-boundary design; runtime
choice pending user answer. Work only on work/openclaw-gateway in
/home/dev/agent-connect-openclaw. Personal /home/dev/agent-connect stays on
main; no live cutover or push authorized by this plan.

## Objective and evidence

Implement an OpenClaw-based Agent Connect that removes duplicated runtime and
Responses machinery, keeps the easy application SDK, and lets users lend their
AI subscription to third-party applications. Document choices and prove the
actual browser/tool/conversation flow. A second permanent backend is not success.

See [dependency investigation](../research/2026-09-05-openclaw-replacement.md).
Published OpenClaw 2026.9.1's built-in loop passes a real-gateway deterministic
client-tool round trip. Its separately pinned native Codex plugin drops client
tools. The user has been asked whether OpenClaw's subscription-backed loop is
acceptable or the native Codex gap must be repaired. Shared policy mediation can
be implemented without deciding that question; final live validation cannot.

## Architecture decision to implement

Retain the existing enrollment/PKCE/grant/capability code and browser SDK.
Replace Omnigent provisioning, retained-run adapters and synthetic Responses
generation with direct mediation of OpenClaw Responses. Construct the upstream
request from the bounded profile and approved tools; construct headers from
operator configuration, never from caller-selected routing headers. The upstream
token stays server-side, with a pinned agent/model policy and a private stable
session key per opaque Agent Connect session.

Keep only durable state needed to authorize responses/calls, reject duplicate or
conflicting continuation, persist requests before publication and describe an
interrupted delivery honestly. Do not preserve the old engine shape merely to
avoid changing internal tests. OpenClaw owns inference, model history, compaction,
runtime credentials and process behavior. No upstream private plugin API in the
public SDK. No implicit session adoption, transcript replay, global owner bearer
in the browser or silent fallback to another model/harness.

The built-in OpenClaw loop projects client tool results as user text after a
synthetic delegated-tool result. This differs from native tool-role continuation;
document it and prove useful result consumption with the selected live runtime.
OpenClaw's response cache is only 30 minutes/500 entries. Local ownership checks
and explicit private session routing must reject stale/foreign IDs independently
of its fallback routing. Recovery may honestly report interrupted/unrecoverable;
do not recreate retained-run machinery merely to conceal an upstream limitation.

Public response IDs may be upstream Responses IDs if ownership is checked locally;
private runtime session keys must never reach clients. Re-inject approved tools
on every segment (SDK omits them on continuation). Avoid another model event
vocabulary: normalize only public model identity/necessary standard fields, and
validate security-relevant event/resource structure before forwarding.

## Scope inventory and compatibility oracle

Baseline 511a828. Retain runtime challenges, authorization requests, owner
consent/grant pages, token exchange/revoke, app-session creation/capability
refresh, streaming and non-streaming Responses, function-result continuation,
completed-turn follow-up, cancellation, recovery GET extensions and owner session
management. Preserve their behavioral security contract, not internal backend
interfaces. SDK source/native-WebMCP/headless-chat behavior remains compatible.
Current authorization, SDK and response-route tests are the behavioral oracle;
port relevant tests to the new dependency, not synthetic Omnigent fixtures.

Edge inventory: denied consent, revoked grant, expired capability/session,
cross-origin and cross-session access, stolen response/call IDs, tool substitution,
arbitrary routing fields, unsupported fields, concurrent admission, repeated or
conflicting output, dropped streams, explicit stop while streaming/parked,
runtime outage, gateway restart, uncertain output delivery, failed durable writes,
parallel independent apps, capacity escape hatch, and safe migration/rollback.

No image/file support, transcript-replay UX, public exposure, auth standard
migration, second provider framework, or Bookhand-specific SDK behavior. Existing
grants/identity remain readable. Old Omnigent conversations cannot be resumed as
OpenClaw conversations: mark them explicitly interrupted or require a new session,
never reinterpret private provider IDs. Retired backend scripts must not disappear
from the live main checkout while it is running.

## Validation contract

### VAL-OC-001: Application authority survives replacement

Surface: API and browser authorization.
Needs: isolated real gateway and initialized throwaway auth state.
Behavior: retained consent/grant/session flows above, exact approved tool snapshot,
origin binding and explicit session ownership; malicious routing and stolen IDs
cannot change agent/model/session/tools or reveal operator credentials.
The default selected runtime exposes only approved application tools, with host
shell/filesystem/network/MCP tools disabled by explicit operator policy.
Evidence: existing authorization/public-route regression cases plus real HTTP
negative probes, browser consent+SDK connection, revocation and independent apps.
Inspect tools offered to the inference/runtime boundary, not just returned calls.

### VAL-OC-002: Responses client-tool conversation

Surface: real OpenClaw API, installed SDK and browser WebMCP tool.
Needs: pinned OpenClaw and supported selected runtime, deterministic inference
fixture for routine checks; authorized subscription for final smoke.
Behavior: initial prompt, streamed text, browser tool, output continuation, final
text and follow-up on one private conversation; ordinary OpenAI Responses client
works; non-streaming success/failure is honest. Tools execute only after durable
recording and only from the approved snapshot.
Evidence: real OpenClaw wire traces and fixture-observed tools/results; existing
SDK/headless/WebMCP tests; one real browser-to-subscription tool/follow-up trace.
The live trace must show meaningful consumption of the actual application result,
not only HTTP success or a deterministic fixture's scripted answer.
Fail: native Codex support claimed using only the built-in loop, or provider
semantics proven only by a fake OpenClaw server.

### VAL-OC-003: Bounded safe lifecycle and recovery

Surface: API, persisted state and real dependency interruption.
Needs: VAL-OC-002 deterministic setup plus isolated durable directories.
Behavior: latest-checkpoint admission, independent sessions, no double delivery
on identical repeated submissions, conflicts rejected, honest uncertain-delivery/restart outcomes,
stop/disconnect/revocation prohibit further tool delivery; no silent replay or
retained unbounded upstream generation. Recovery extensions cannot expose another
session or return a call whose continuation is known impossible.
Persist ambiguous upstream acceptance as uncertain and never automatically retry
it. This is a local no-redrive policy, not an exactly-once side-effect guarantee.
Immediate publication/admission cancellation is separate from actual upstream
generation stopping. Prove the latter with the real dependency; if unsupported,
report cancellation as locally enforced and the upstream stop as unconfirmed,
and do not close this contract until resource lifetime is bounded and documented.
Evidence: controlled local ledger write/race faults where appropriate, real
OpenClaw disconnect/cancel, restart-before-publication and restart-after-output
attempt probes, HTTP recovery/cross-session assertions. Do not claim exactly once.

### VAL-OC-004: Operable replacement with less custom ownership

Surface: CLI, deployment artifacts, repository and documentation.
Needs: preceding contracts, runtime choice resolved.
Behavior: documented pinned OpenClaw/plugin/runtime setup; operator credential
never disclosed to applications; normal SDK use needs no per-app terminal work.
Old custom runtime/Responses generation removed from supported path and obsolete
code deleted. Existing gateway identity/grants preserved; new sessions explicitly
created after backend migration; clean rollback instructions. Default verification
tests the real dependency shipped without paid model calls.
Evidence: clean-install/startup and migration rehearsal using disposable state,
final real subscription smoke, full relevant verification once, independent review,
production deletion/ownership inventory and consistent source-of-truth docs.

## Progress and next action

- Investigations and two real dependency probes complete; all probe services stopped.
- Separate checkout dependency install: quiet-run.h2l9rg (poll before using).
- Contract review: two sequential independent passes complete; shared implementation ready.
- Pass 1 incorporated: host-tool isolation, actual cancellation evidence,
  tool-result projection caveat, no-redrive uncertainty and bounded recovery.
- Runtime selection question pending; do not treat the mission as complete until
  the selected subscription-backed path actually works.
- Shared authority/request-shaping and ledger work can proceed after review;
  runtime-dependent setup, continuation/cancellation proof and final acceptance
  stay open until the runtime choice and executable evidence resolve them.
- Next: review contract, implement the shared policy bridge/session ledger and
  gateway integration, then validate and remove superseded machinery. The design
  is allowed to shrink further when a responsibility can safely move upstream.

## Work ownership and validation schedule

- W1 (gateway replacement): owns VAL-OC-001/002/003. Replace gateway-owned runtime
  and Responses machinery; preserve auth and SDK behavior; port behavioral tests.
  Own packages/gateway and only necessary SDK error/compatibility fixes. No live
  service work or dependency manifest edits. Runtime-neutral upstream config.
- W2 (operator/test setup): owns VAL-OC-004. Pin dependency/install procedure,
  safe runtime profile and real-dependency fixture/commands; document migration
  and deletion. Starts with deterministic setup while runtime choice remains open.
  Own deploy/openclaw-gateway, scripts/openclaw*, root verification wiring/config.
- V1 scrutiny: independent review of final implementation, boundaries, tests and
  documented compatibility/deletions; run targeted checks then full verification.
- V2 real surfaces: real dependency/API, installed SDK and browser/subscription
  composition, including cancellation/restart/denial; evidence by contract ID.
- Gate: no default cutover/completion until both validation lanes prove all four
  contracts and runtime choice is resolved. No push without an explicit prompt.

### W1 implementation checkpoint

- Thin OpenClaw HTTP Responses mediation now replaces Omnigent provisioning,
  retained BackendRun and SegmentWriter. Existing fsync-backed ownership/call
  records remain readable; authorization identity/grant storage is unchanged.
- Required operator config: OPENCLAW_BASE_URL, OPENCLAW_TOKEN, OPENCLAW_AGENT_ID.
  Application requests cannot choose upstream routing or model. Private session
  keys are allocated locally and never repaired/adopted implicitly.
- Admission reserves a session and commits the no-redrive record before upstream
  output submission. Failed/ambiguous delivery blocks continuation. Call events
  are held until the upstream terminal checkpoint and durable local call record;
  only the approved tool snapshot can be published.
- Superseded checkpoints, prior-provider chains and interrupted in-flight
  work require a fresh session. Recovery strips impossible pending calls. The
  owner console labels interruptions and unknown usage honestly.
- Gateway build passed before final formatting. Test porting/real dependency
  evidence were subsequently completed in the dedicated test lane. These are implementation
  checkpoints, not VAL-OC verdicts; cancellation and final subscription evidence
  remain open.

### Shared implementation handoff, 2026-09-05

- Work is isolated on `work/openclaw-gateway` in
  `/home/dev/agent-connect-openclaw`; live main and the personal gateway have
  not been switched or restarted. No pushes or credential changes.
- Real dependency tests cover streaming calls, outputs, follow-ups, ordinary
  OpenAI-client nonstream use, isolation, cancellation and gateway process death.
  All 14 real gateway cases passed after correcting a fixture observation race;
  final Canvas compatibility checks also passed in the persistent checkout.
- Independent scrutiny found and reprobed four publication/authority races:
  recovery before call commit, cancellation during pending lookup, mismatched
  held tool identity, and revocation before terminal yield. All fixed; see
  `docs/reviews/openclaw-replacement-scrutiny.md`.
- Removed the Omnigent production adapters, retained-run/event machinery, old
  deployment launcher and Codex-ACP helpers from this branch. Git/main retain
  the old installation for rollback. Test replacements and remaining coverage
  limits are mapped in `packages/gateway/test/README.md`.
- The clean pinned installer and private initialize/check/serve rehearsal passed
  without inference. Default verification now requires actual OpenClaw and
  includes process-crash tests. CI uses the same pin and Node 24.15.
- **Next release gate:** José must choose whether the built-in OpenClaw loop
  using his subscription meets the product goal, or whether native Codex is
  required (its current adapter drops client tools). Then validate that actual
  runtime through a browser and meaningful tool-result follow-up. No live
  cutover or full VAL-OC pass is implied by deterministic tests or scrutiny.

### Demo and verification update

José selected **Bookhand**, not the bundled Canvas, as the replacement's real
demo. The Bookhand agent in `cdx2:1.1` was instructed to switch its existing
checkout to a dedicated branch, with no parallel worktree or old demo to keep
running. Gateway cutover and subscription configuration remain coordinated here.

Verification was collected in stages rather than repeating successful work:

- Format, typecheck, 80 gateway unit cases, 98 SDK cases, builds and lint passed.
- The three published-OpenClaw fixture checks passed. All 14 real gateway
  integration cases, including process crashes, passed in `quiet-run.H5PhHm.log`.
- The installed SDK package check and all 14 native WebMCP browser tests passed
  (the latter in `quiet-run.ccYezW.log`).
- Initial detached runs lost the custom executable environment; put `env ...`
  inside the quiet-run command because its tmux worker inherits server state.
- A cancellation observation race was in the fixture: it exposed readiness
  before registering the close listener, across an awaited evidence write.
  Registering first fixed it. The cancellation deadline was not relaxed; cold
  inference startup now has a separate explicit readiness deadline.
- Canvas passed after updating old provider-name assertions. Final format and
  diff checks also passed. These checks do not prove the live subscription demo.

Logs named above currently live under `/tmp/agent-connect-command-logs`; the
source tests and these results are persisted here. A VM restart may remove raw
logs and disposable dependency installations, but not this checkout or branch.

Bookhand confirmed its installed SDK distribution matches this branch's common
SDK files and its 18 Tutor tests pass. No application transport patch is needed.
It reported two pre-existing SDK issues for separate follow-up, not yet verified
or fixed here: `agent-session.ts` may label returned tool failures successful in
activity events, and `responses-provider.ts` maps all HTTP 401 responses to
`invalid_app_grant`. Do not add a Bookhand-specific transport workaround.
