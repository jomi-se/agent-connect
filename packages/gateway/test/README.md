# Gateway replacement regression map

The OpenClaw replacement retains public behavior, not the retired Omnigent
backend interface. These tests deliberately separate AC-owned fault injection
from compatibility with the actual pinned OpenClaw process.

| Contract / previous oracle                                                  | Current evidence                                                                                                                                                                                                                                                                                                                          | Intentionally retired assumption                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| VAL-OC-001; `gateway.test.ts`                                               | Existing CORS, identity, origin, enrollment, consent, PKCE, token replay, grant revocation, dynamic enrollment and exact-tool capability cases remain. Explicit-session refresh replaces provider-provisioning assertions.                                                                                                                | Creating/repairing an Omnigent runtime session during application authorization.                          |
| VAL-OC-001; old `responses-route.test.ts` ingress cases                     | `responses-profile.test.ts` retains the bounded request profile. `responses-route.integration.test.ts` rejects model/instruction/metadata/tool substitutions and stolen response access, and submits malicious routing headers through real OpenClaw.                                                                                     | Forwarding caller-selected provider routing or accepting an arbitrary Responses profile.                  |
| VAL-OC-002; old `responses-engine.test.ts`, `responses-conformance.test.ts` | `openclaw-mediation.integration.test.ts` exercises actual streamed tool calls, result consumption, approved-tool reinjection, and completed-turn follow-up. `responses-route.integration.test.ts` uses an unmodified OpenAI client for public nonstream responses. Existing Open Responses fixture/schema and tool snapshot tests remain. | Synthesizing Omnigent event sequences in a fake backend and calling that provider compatibility.          |
| VAL-OC-003; old engine/route lifecycle cases                                | Real mediation tests cover independent sessions, stolen calls, consent revocation, output conflicts, identical-output no-redrive, parked-store reconstruction, cancellation, concurrent admission, and actual inference socket closure.                                                                                                   | Retained-run reattachment and implicit provider session healing.                                          |
| VAL-OC-003; `responses-durability.test.ts`                                  | Controlled AC-owned disk failures verify no phantom state, durable retirement, no network before durable admission, consent recheck after a store await, and uncertain network acceptance blocking retries after reconstruction.                                                                                                          | Retry/resend to hide ambiguous upstream acceptance. These faults are not OpenClaw compatibility evidence. |
| VAL-OC-003; `responses-process-crash.integration.test.ts` and fixture       | Real gateway subprocess exits immediately after the first durable call write (before publication), or after durable output-attempt recording (before network send). Restarted HTTP recovery offers no impossible call, continuation is rejected, and the actual runtime observes no redrive.                                              | Old Omnigent transport-specific acknowledgment phases and retained task adoption.                         |
| VAL-OC-002/003; failed nonstream route                                      | `gateway.test.ts` injects a deliberate transport rejection and requires a 502 `backend_unavailable`, not a successful in-progress resource.                                                                                                                                                                                               | Pretending HTTP failure proves any actual provider behavior.                                              |

Deleted provider-specific files: `omnigent-real.integration.test.ts`,
`omnigent-response-backend.test.ts`, `omnigent-runtime.test.ts`, and
`support/fake-backend.ts`. Their supported-dependency role moves to
`scripts/openclaw-compat.test.mjs` plus the three gateway integration suites.
Deleted monolithic `responses-engine.test.ts`, `responses-route.test.ts`, and
`responses-conformance.test.ts` are replaced by the focused tests mapped above;
they are not disabled or silently retained as skipped tests.

## Running and limits

Ordinary gateway tests run without starting a provider. The three `*.integration`
suites require `RUN_OPENCLAW_INTEGRATION=1`, the pinned OpenClaw executable, and a
supported Node executable. Build the gateway first: the crash fixture imports
the built gateway. Default repository verification must include all three real
integration files, including process crash; merely running ordinary `npm test`
is not sufficient compatibility evidence.

The real mediation suite also pauses the AC-owned resource write before call
commit and verifies recovery cannot publish that call. A second controlled store
read lets cancellation win before pending-call delivery, which must return no
stale calls. These await-boundary faults exercise local authority while the
upstream response itself comes from actual OpenClaw.

These checks use actual OpenClaw with deterministic model inference, not a paid
subscription. They do not establish browser rendering, live subscription result
quality, native Codex-plugin compatibility, every old capacity/reaping schedule,
or upstream recovery beyond the tested boundaries. The separate final scrutiny
and real-surface lanes own those acceptance checks. Identical-output rejection is
a local no-redrive policy, not an exactly-once side-effect guarantee.
