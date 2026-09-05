# Current work

Updated: 2026-09-05

This is the canonical unfinished-work list. It records current priorities and
only enough completed context to explain them. Product boundaries live in the
[mission](../mission.md), capability status lives in the
[scope inventory](../scope-inventory.md), and architectural choices live in
[`docs/decisions/`](../decisions/).

## Working baseline

The hackathon MVP proved the core loop through a deterministic public fixture
and a source-installable Tailscale Serve gateway using a real user-owned Codex
login through Omnigent. The judge-only deployment and anonymous transport
profile were removed after judging; the private real-Codex profile is the sole
supported deployment.

The browser SDK verifies a selected gateway, obtains a revocable Origin-bound
grant, supplies an exact user-approved application-tool snapshot, streams a
task, executes requested application functions, returns correlated results,
and hides raw Omnigent identifiers.

The bounded Open Responses profile now passes its standard-client, real-Codex
browser, gateway-process-death, and Omnigent-process-death gates. It is the sole
browser task wire. The old public task/event routes and browser-visible
Omnigent provider have been deleted; Omnigent remains the first internal
backend.

A 2026-08-28 clean-context
[implementation review](../reviews/2026-08-28-open-responses-implementation-review.md)
found and closed silent persistence, cancellation, dead-run delivery, stream
termination, rehydration, and provider-timeout failures. Provider-sensitive
claims now use the
[real-dependency testing strategy](../architecture/testing-strategy.md): real
Omnigent plus a deterministic ACP agent is the routine compatibility oracle;
in-process backends prove only Agent Connect-owned invariants and injected
fault handling.

The 2026-08-29
[re-review](../reviews/2026-08-29-open-responses-re-review.md) independently
confirmed those fixes and found a separate disconnect-cancellation hang. That
path now terminalizes without a provider event, corrupt chain files are
quarantined without blocking healthy startup, continuation cancellation is
checked before provider delivery, and real Omnigent is enforced by the default
`verify` command.

The automated baseline remains:

```sh
npm run verify:full
```

`verify:full` includes the real-Omnigent compatibility gate and the crash suite
that kills disposable gateway subprocesses. A real Codex/browser composition
remains a deliberate manual milestone because it consumes the operator's
credentials and model allowance.

Linear completed-task continuation is implemented under
[ADR 0011](../decisions/0011-linear-multi-turn-continuation.md). Each follow-up
is a new immutable response chain on the same Omnigent/ACP session, guarded by
a durable session head. Gateway, SDK, browser, and real-Omnigent contracts pass;
the remaining evidence gap is a recorded manual real-Codex correction that
depends on first-turn-only context. The user reported successful continuation
in the development conversation, but that is not a preserved trace proving
this narrower assertion. Fresh connections are independent. Session lifetime
slides on activity, independently of capability TTL: idle 15 minutes,
unanswered function call 3 minutes, stalled running turn 30 minutes by default.
Retirement tears down the provider session and gateway-owned workspace.

The last implementation commits are `5b1628e` (lifecycle and owner console),
`cb70738` (retirement/admission races and stream-open timeout), and `3c534df`
(no implicit session adoption). A grant always creates; a capability selects
exactly its own session. Concurrent creates reserve capacity independently.
The owner-only `/sessions` console exposes live sessions, usage, expiry, and
termination. Lost creation responses can leave bounded orphan sessions;
creation idempotency is deferred until this is an observed problem.

## Headless conversation building blocks: implemented

Requested 2026-09-05: a framework-neutral conversation layer over AgentSession,
with streaming transcript, tool activity and send/stop/follow-up controls.
See [the contract and handoff](headless-chat.md). UI packages and Bookhand
integration remain subsequent work; the user explicitly deferred images/files.

`createAgentChat` now exposes immutable ordered transcript snapshots, subscriptions,
send/stop/dispose controls and truthful continuation readiness. AgentSession owns
tool execution and cooperative cancellation. `exportAgentChatMarkdown` supports
portable study notes without exporting tool argument/result bodies. No UI library,
new protocol or automatic reconnect was introduced. Bookhand composition is next.

## WebMCP tools: implemented and validated

Requested 2026-09-04: consume WebMCP tools through the existing approved
snapshot and Open Responses loop. Investigate native discovery/execution,
implement a bounded adapter, and validate it against a real browser API.
Keep explicit `defineTool` applications working. No new gateway protocol,
browser extension, or automatic expansion of approved tools is required.
Bookhand integration follows this work; it is not part of this SDK change.

`createWebMcpToolSnapshot()` now maps native current-document tools to existing
`ApplicationTool` objects. Metadata is frozen before consent; observed registry
changes permanently invalidate the snapshot. Native Chrome 153 JSON-string
binding is experimental and explicitly differs from the current draft. See the
[implementation and validation ledger](webmcp-tool-source.md) for evidence and
the same-name handler replacement limitation. Bookhand composition is next,
not yet implemented or validated.

## Release evidence housekeeping

The user confirmed the single-wire private demo worked after the default
switch. This is user-reported composition evidence, not a new automated run.
Existing traces and tests remain the implementation evidence. Do not repeat
the completed protocol migration just because its ADR status is still open.
Capture the specific first-turn-only continuation smoke when doing the next
real-Codex application demo, then close ADR 0011's evidence gate.

## Completed milestone: Open Responses replacement

Follow the
[Open Responses vertical-slice implementation plan](open-responses-vertical-slice.md)
for the implemented slice and its evidence. The following now pass:

1. expose the documented version 0 Open Responses HTTP/SSE profile;
2. map `agent-connect/default` to one real Codex-backed execution;
3. complete multiple sequential application function calls through
   `previous_response_id` continuation;
4. preserve the exact user-approved function snapshot;
5. keep runtime-owned tools and application-owned functions distinct;
6. persist each application call before publication and retain its stable call
   ID through result submission;
7. define cancellation, interruption, recovery, malformed-call, and harness
   failure behavior; and
8. prove the protocol shape with an ordinary Open Responses client; and
9. prove the full browser-to-gateway-to-Omnigent-to-real-Codex flow from fresh
   authorization; and
10. kill real gateway and Omnigent processes at the declared durability
    boundaries and recover deterministically.

The default switch and deletion are implemented under
[VAL-RESP-008](../../contract/VAL-RESP-008.md); subsequent user testing reported
the private composition working. No replacement implementation remains.

WebMCP was outside this completed milestone and is now the active follow-up.

## Priority 2: one-click user-owned deployment

Turn the working source profile into an installation a normal technical user
can launch without understanding Omnigent, ACP, MCP, or the internal service
topology.

The first proof should favor one reproducible deployment over a generalized
deployment framework. GitHub Codespaces is a promising low-friction entry
point, but private forwarded-port authentication, mobile browser behavior,
sleep, and manual wake-up still need a focused prototype. Tailscale remains a
power-user path. Do not make a founder-operated relay mandatory.

The deployment must make credential injection, update, restart, gateway-card
export, health, and teardown explicit. Packaging convenience is not a claim of
process isolation, credential confinement, or multi-tenancy.

## Priority 3: remaining operator basics

Pending-call persistence, stable call IDs, same-output retry, capability
refresh, cancellation, restart reconstruction, and deterministic process-loss
outcomes are implemented for the bounded slice. The remaining operator work is:

1. add small operator commands for runtime-card re-export, device management,
   gateway-key rotation, recovery, and audit history.

Session/workspace teardown and the owner session console are implemented.
Any future orphan-directory sweep is distinct from normal retirement cleanup
and needs evidence of leftovers before expanding maintenance scope.

Use stable action IDs and require idempotent application operations or
application-owned deduplication. Do not claim generic exactly-once execution.

## Priority 4: compelling applications

Once the Open Responses scaffold works, validate the product through real
applications rather than further protocol invention. A useful application
should:

- solve a problem the user genuinely has;
- benefit materially from a powerful user-owned runtime rather than a single
  ordinary model request;
- use application-owned functions in a way that justifies Agent Connect; and
- make the gateway infrastructure mostly invisible.

Bookhand is now a separate published WebMCP ebook reader and is the next
candidate for optional Agent Connect integration. Its product test is whether persistent progress, source-aware
lessons, exercises, and agent-driven application actions produce something
meaningfully better than an ordinary document-chat product. Select and build
one narrow application before expanding into a generic application platform.

## Bounded maintenance

Maintenance is justified when it unblocks one of the priorities above:

- preserve provider-neutral browser APIs and keep Omnigent/Codex types internal;
- resolve `gateway` versus legacy `connector` terminology when touching the
  relevant surface;
- add structured logging, SSE cancellation/backpressure, and stable error
  mapping as required by the Open Responses slice;
- decide browser handler deadlines, malformed-argument correction behavior,
  and whether recovery control routes become automatic SDK behavior before
  claiming those product semantics;
- remove obsolete scaffolding at the migration deletion point; and
- publish `@open-agent-connect/web` only after its compatibility and security claims
  match the tested package.

Do not undertake broad route-framework rewrites, speculative harness
frameworks, mass renaming, or generalized-provider refactors for architectural
neatness alone.

## Deferred or optional

- AG-UI: optional future edge adapter only for a concrete UI need;
- ACP: optional harness-facing adapter where stable capabilities fit;
- MCP and harness-native dynamic tools: backend techniques, not public
  requirements;
- Browser extension: possible later host for the WebMCP adapter; current work
  is a page SDK integration, still subject to exact snapshot approval;
- a second backend: add after the Codex/Open Responses slice reveals the real
  adapter seam;
- arbitrary multi-agent orchestration;
- Android automation;
- public multi-tenancy, billing, or a mandatory hosted relay;
- hardware-attestation claims; and
- replacing Omnigent solely to make the architecture look more neutral.

## Historical material

The Build Week submission, judge environment, AG-UI spike, sandbox experiment,
and container deployment plan remain useful dated records. They are not the
current backlog unless an item above links to them explicitly.
