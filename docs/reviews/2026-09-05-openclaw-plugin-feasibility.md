# OpenClaw plugin feasibility validation

Date: 2026-09-05. Pin: published OpenClaw 2026.9.1.
Scope: [three bounded contracts](../plan/openclaw-delegation-spike/README.md),
not production authorization or a Bookhand release gate.

Final verdict: **VAL-PAIR-001, VAL-RUNTIME-001 and VAL-AUTHORITY-001 pass**
within their stated feasibility scope. Independent source scrutiny and real HTTP
reproduction agree; sandbox evidence comes from a separate execution lane.

## Evidence

- Final independent amended reproduction: `quiet-run.hND5PU.log`, fresh runtime
  `/tmp/agent-connect-openclaw-test-7JVsyh`, exit 0. All three contracts pass;
  the earlier authority evidence-gap verdict is superseded. An independent
  SQLite reread confirms the hostile-header turn retained A's one native session
  and creator. This repeats the amended assertions below, not just their logs.
- Initial independent HTTP reproduction: `quiet-run.gV6wjO.log`, runtime
  `/tmp/agent-connect-openclaw-test-joFybC`. Pairing and runtime passed. Authority
  initially failed its evidence floor: hostile app headers/body were untested.
- Amended implementer reproduction: `quiet-run.pTJ1ZX.log`, runtime
  `/tmp/agent-connect-openclaw-test-7XXpUo`. Approved B cannot use A's opaque
  session (403). Forged identity/agent/session/write+admin headers do not change
  A's native authority (200 on its own session). Alternate model is 403; raw
  agent/session selectors in the body are 400. Earlier assertions still pass.
- Independent sandbox lane: `quiet-run.WRIxiD.log`. Positive control at
  `/tmp/agent-connect-openclaw-test-bNChPN/sandbox-evidence.json` executes a host
  marker command. Required policy at
  `/tmp/agent-connect-openclaw-test-lciWs3/sandbox-evidence.json` persists the
  app creator and sandbox requirement before Responses, returns 500 with Docker
  unavailable, makes zero inference calls and does not create the host marker.
- Independent source scrutiny passes the three bounded contracts' source checks.
  Native explicit routing headers take precedence, response-chain lookup is
  principal/agent/session-bound, and native authorization follows that lookup.
  Syntax checks pass for plugin, main probe, sandbox probe and runtime helper.

All log basenames above live under `/tmp/agent-connect-command-logs/`. These are
ephemeral evidence pointers; the reproducible probes and this result summary are
committed. No personal credentials, live service changes or paid inference were
used. The deterministic model substitutes inference only, not OpenClaw behavior.

## Interpretation constraints

The main probe reads creator provenance at the first fixture inference callback,
after admission; the sandbox probe separately reads it before Responses. Native
admin-only 403 proves missing `operator.write`, not rejection of combined native
write/admin authority. The hostile app header test proves the plugin does not
forward that escalation. Native sibling/agent denials are independent core checks.

The exact-route test proxy models public ingress; it is not an actual Tailscale
deployment test. Loopback is trusted, not per-process isolation. Required sandbox
failure is proved, but successful container execution is not. Grant revocation
blocks subsequent requests, not necessarily already-running streams. Useful native
tools remain available; unrestricted host-file tools can still expose secrets.

Memory-only grants/session maps, missing consent UI/CORS, expiry/quotas, fixed-tool
snapshots and concurrency/disconnect handling prevent calling this a shippable
authorization implementation. See the [research verdict](../research/2026-09-05-openclaw-app-delegation.md).
