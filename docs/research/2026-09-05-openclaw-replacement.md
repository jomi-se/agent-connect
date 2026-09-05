# OpenClaw replacement investigation

Status: active investigation, not completed migration. User authorized an
OpenClaw-based Agent Connect that minimizes custom gateway code while preserving
easy subscription-backed application access through Open Responses and the SDK.

## Verified baseline

- Agent Connect baseline: 511a828. Working private Omnigent gateway remains in
  tmux agc; do not replace its live configuration as part of exploratory tests.
- Published OpenClaw: 2026.9.1. Official source is available at tag v2026.9.1.
- OpenClaw src/gateway/openresponses-http.ts implements client-defined function
  tools and SSE. Its response-to-session cache expires after 30 minutes and is
  capped at 500 entries. Explicit private session routing is necessary; the
  cache cannot establish Agent Connect's authorization/ownership boundary.
- SDK requires POST /v1/app-sessions, POST /v1/responses and the Agent Connect
  response cancel extension. It executes tools on response.output_item.done;
  tool publication must remain durable before that event reaches the browser.
- Existing backend.ts assumes a retained long-lived harness run and translates
  provider events into another event vocabulary. That is not automatically the
  right seam for an upstream that already speaks Responses. Investigate direct
  policy mediation and deletion of engine/segment translation rather than merely
  adding an adapter to all existing machinery.
- OpenClaw's operator token must remain server-side. Construct outbound headers
  and runtime selection internally; never forward arbitrary app routing fields.

## Replacement surface inventory

The existing SDK also requires runtime-challenge verification, authorization
request creation, the owner /authorize page, OAuth token exchange and revoke.
Retain these application-facing authorization surfaces. Grant connections create
distinct sessions; only explicit capabilities reconnect to a named session.
Originless clients retain their additional owner-transport/non-browser-consent
gate. Model selection remains agent-connect/default externally.

Response IDs must be checked against the authorized app session on continuation,
cancel and recovery. Continuations use the latest admitted checkpoint; a request
refused before admission must not destroy it. Tool definitions are fixed at
consent, re-injected internally on continuation, and checked on outbound calls.
Retain one active task per app session and independent parallel app sessions.

The GET chain and pending-function-calls extensions are not automatic SDK
dependencies, but are published APIs. Any changed recovery behavior needs an
explicit decision and documentation, not silent deletion. /sessions is the
owner's escape hatch for capacity/retirement. A small durable session/response/
pending-call ledger remains necessary unless the dependency can supply the same
authority and publication guarantees. Never infer exactly-once execution from a
transport retry.

Deletion candidates: omnigent-runtime.ts, omnigent-response-backend.ts, retained
BackendRun/event translation, SegmentWriter and most of ResponseEngine. Baseline
gateway production source is 6,461 lines (wc -l over src/_.ts and
src/responses/_.ts); minimizing maintenance is the goal, not a line-count quota.
Existing SDK tests, authorization tests and response-route behavioral tests are
the compatibility oracle; Omnigent-specific tests become historical when that
dependency is removed, not proof for the replacement.

## Readiness and live handles

- Source checkout: /tmp/openclaw-contract.suVXov/openclaw-2026.9.1.
- VM Node 24.14.0 is below this release's supported minimum. First isolated npm
  install failed at the explicit version check; no machine package was changed.
- Isolated Node 24.15.0 installation passed (quiet-run.KbdBwe), followed by
  OpenClaw installation (quiet-run.RJSmRr). Executable environment:
  /tmp/agent-connect-openclaw-node/node_modules/.bin on PATH, executable
  /tmp/agent-connect-openclaw-2026-9-1/node_modules/.bin/openclaw.
  gateway run --help succeeds and reports 2026.9.1 (ad6fe23).
- No credentials copied, services restarted, code switched, or network ingress
  changed during this investigation.

## Evidence still required before implementation contract

1. Real OpenClaw client-tool round trip through native Codex, including tool
   result continuation, follow-up, cancellation and restriction of host tools.
2. A deterministic real-OpenClaw test path that spends no subscription tokens.
3. The smallest retained session/call bookkeeping needed for app isolation,
   duplicate outputs, cancellation, restart and persist-before-publication.
4. Operator setup and migration path preserving existing gateway identity/grants.

## Executed dependency probes

Native Codex gap confirmed with real openclaw@2026.9.1 and separately installed
@openclaw/codex@2026.9.1. A required HTTP client tool plus an explicit allowlist
containing that tool produced thread/start.dynamicTools=[] at the native
boundary. Native shell was disabled. After the deterministic fixture completed,
HTTP returned 502 because the required tool was not called. Tool absence is
observed before model choice, not inferred from an unsuccessful model answer.
Evidence and minimal upstream fixture adaptation:
/tmp/openclaw-contract.suVXov/RESULT.md. All probe services stopped.

The built-in OpenClaw loop passed the same direction of interaction: with all
built-in tools denied, exactly the requested client tool reached deterministic
inference; function call, output submission and conversational follow-up all
returned HTTP 200. Caveat: the submitted output is projected as user text after
a synthetic delegated-tool result, not restored as a native tool-role response.
Evidence: /tmp/openclaw-loop-probe.VihhDc/{probe.mjs,gateway-wire.jsonl,
model-requests.jsonl,result.jsonl}. All probe services stopped; no real credentials
or subscription tokens were used. This proves transport composition, not model
judgment or subscription auth.

The user has been asked whether OpenClaw's own loop with subscription auth is
acceptable or native Codex must remain. Do not silently substitute harnesses.
The common application-authorization boundary remains useful in either case.

Development branch: work/openclaw-gateway. Product changes will use a separate
checkout so the personal agc installation stays on its working source revision.

The final goal is a usable replacement with less custom ownership, not an
additional permanently supported backend. User deferred transcript-replay UX;
do not silently add replay or treat a new runtime conversation as the old one.

Sources: https://docs.openclaw.ai/gateway/openresponses-http-api,
https://docs.openclaw.ai/concepts/agent-runtimes,
https://docs.openclaw.ai/gateway/external-apps,
https://github.com/openclaw/openclaw/tree/v2026.9.1.
