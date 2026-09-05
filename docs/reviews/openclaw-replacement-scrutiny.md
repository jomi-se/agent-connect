# OpenClaw replacement scrutiny

2026-09-05; V1 shared-implementation review in the isolated replacement checkout.
Selected subscription/runtime acceptance is expressly outside this pass. No live
personal services or credentials were accessed. Product edits were made by W1,
not the reviewer.

## Hard-Gate Commands

- `npm run build --workspace @agent-connect/gateway` through quiet-run: exit 0,
  including a fresh rebuild after W1's recovery and held-event fixes.
- `npm exec --workspace @agent-connect/gateway -- vitest run responses-durability.test.ts`
  through quiet-run: exit 0. Narrow authority regression only; no full-suite rerun.
- `node /tmp/openclaw-scrutiny-recovery-probe.mjs`: initially exit 1; after fix,
  exit 0. Recovery during paused call persistence now exposes zero calls while
  the call ledger remains empty.
- `node /tmp/openclaw-scrutiny-cancel-probe.mjs`: initially exit 1; after fix,
  exit 0. Cancellation during pending-call lookup now returns zero stale calls.
- `node /tmp/openclaw-scrutiny-event-probe.mjs`: exit 0 after fix. A mismatched
  held function-call identity produces `backend_protocol_error`, publishing no call.
- `node /tmp/openclaw-scrutiny-terminal-probe.mjs`: exit 0 after fix. Revocation
  while paused after the final held call event prevents terminal publication.

These four disposable probes inject local storage/protocol faults; they are not
evidence of OpenClaw's behavior. Final mechanical verification belongs to the parent.

## Per-Target Verdicts

### VAL-OC-001: passed (shared scrutiny only)

- Needs: throwaway authorization and pinned real dependency evidence supplied by W2;
  selected operator runtime confinement remains a release gate.
- Evidence: existing authorization/profile tests, route integration source,
  `openclaw.ts` request/header allowlist, store ownership collision guards, and
  W2 logs listed below. The sibling real-surface validator owns browser evidence.
- Review: retained grants/capabilities bind sessions; upstream response/call IDs
  convey no independent authority. Operator tokens and private routing are not
  copied into public resources. The deterministic dependency profile denies all
  host tools and checks the tools actually offered to inference. This does not
  certify an arbitrary external operator profile.

### VAL-OC-002: passed (shared scrutiny only)

- Needs: real selected-runtime subscription consumption remains outside this pass.
- Evidence: real dependency conversation tests, unchanged SDK scope, ordinary
  OpenAI nonstream client test, and the independent malformed-held-event probe.
- Review: source delegates inference and Responses transport without restoring the
  legacy backend protocol. Held call identities now match durable terminal calls.
  W1 also fixed the final terminal-yield authorization boundary identified here.
  An independent generator-pause probe confirms revocation after the last held
  tool event prevents terminal publication; see resolved regression
  `regressions/OC-SCR-004.md`. Selected-runtime and browser acceptance remain open.

### VAL-OC-003: passed (shared scrutiny only)

- Needs: isolated ledger and real dependency interruption evidence supplied by W2;
  sibling real-surface validation still required.
- Evidence: no-redrive/output-attempt source, process-crash tests, narrow fault
  tests, and independent recovery race probes.
- Review: W1 fixed two concrete recovery races found here: terminal response
  persistence no longer publishes a call before its call ledger commit, and a
  session revision barrier suppresses pending/recovery calls after concurrent
  cancellation or continuation. Both fixes were independently rebuilt and retested.
  Terminal-yield authorization was subsequently fixed and independently retested.
  All four disposable probes pass against the freshly rebuilt final reviewed source.

### VAL-OC-004: passed (shared documentation/setup scrutiny only)

- Needs: final runtime choice, subscription smoke and full verification remain
  parent-owned release gates, not results of this review.
- Evidence: production deletion inventory, launcher and setup documentation,
  root default verification command, and W2 regression mapping.
- Review: removed Omnigent provisioning, retained backend/run translation and
  SegmentWriter rather than keeping a second production backend. The new launcher
  preserves explicit identity initialization, confines listeners and protects the
  upstream token. Follow-up documentation inspection confirms root README,
  `docs/architecture/testing-strategy.md`, AGENTS verification guidance and the
  gateway package README now consistently describe the OpenClaw branch. The
  root quickstart explicitly loads its private env file. Historical provider
  behavior is distinguished from current setup, and subscription/browser
  acceptance is still explicitly unproven. `regressions/OC-SCR-005.md` is resolved.

## Evidence Integrity

- Inspected W2 `/tmp/agent-connect-command-logs/quiet-run.KaVuWB.log`: 78 ordinary
  tests passed; 12 real integration tests were explicitly skipped in that command.
- Inspected `quiet-run.KNFCVn.log`: 11 integration passes and one crash-test parser
  failure. This is not represented as a fully passing run.
- Inspected `quiet-run.iCmgz0.log`: both crash tests passed after parser correction.
  W2/parent own the subsequent combined integration/final verification result.
- Inspected `quiet-run.aYSALt.log`: all six real mediation tests passed, including
  W2's newly added precommit-recovery and cancellation-during-lookup regressions.
- `packages/gateway/test/README.md` honestly maps deleted tests to new assertions
  and discloses that not every historical capacity/reaping schedule is covered.
- Real dependency tests use the published OpenClaw process and deterministic
  inference, not a fake OpenClaw server. The inferred model answer and subscription
  behavior are not proven by those deterministic responses.

## Responsibility Drift

No new orchestration framework or legacy production engine retained solely for
tests. Historical Omnigent deployment material is acceptable only when clearly
labeled historical, not presented as the current branch's startup path.

## Review Limitations

No paid model use, live runtime/profile selection, browser rendering, or physical
device test. The parent will name the sibling real-surface lane and collect its
evidence before full target acceptance. Source was changing during scrutiny;
the final mechanical gate must use the stabilized revision.
