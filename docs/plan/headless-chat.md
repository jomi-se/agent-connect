# Headless Agent Connect chat

Status: implemented, independently reviewed and validated, 2026-09-05.
Persistent handoff for this implementation. Next milestone: Bookhand composition.

## Scope and decisions

Build framework-neutral `createAgentChat({ session })` in the existing web SDK.
Optional UI/framework packages can consume it later; no React, DOM, rendering,
or new wire protocol. The helper owns conversation consumption of the supplied
session exclusively. Connection/auth, WebMCP tool-source lifetime and persistence
remain application responsibilities. No automatic reconnect, retry, replay,
history-to-prompt reconstruction, editing/regeneration or branching.

The input is text. The user explicitly deferred images/files on 2026-09-05.
Do not expose an upload that silently drops data or pretend transcript metadata
is agent-visible. Actual multimodal delivery needs a separate contract.

Public building blocks: stable immutable snapshots and subscription/unsubscribe;
ordered user/assistant messages containing text and tool-activity parts;
send (initial or explicit checkpoint continuation), stop and disposal. Assistant
messages retain partial content and completion/failure/cancellation status.
Tool failures are not whole-turn failures. Tool output bodies are not exposed
by current task events and must not be invented. The helper never calls a tool.

Session prerequisites: expose read-only send readiness without exposing checkpoint
tokens. Protect concurrent session consumption. Track provider admission explicitly
at Responses response.created, retaining first-visible-event fallback for custom
providers. Keep known preadmission refusal retryable; unknown network outcomes
are not proof of non-admission. Cancellation needs a local guard before invoking
a requested tool and before submitting its late output, plus an optional tool
context AbortSignal for cooperative handlers. No forced interruption/rollback of JS.

Stop requests cancellation, not instant successful completion. Completion already
observed wins. Cancellation failures remain observable and cannot enable a second
turn while the first is active. Disposal detaches UI observers, rejects future
operations and requests cancellation; it does not revoke auth, delete a remote
session, or dispose a caller-owned WebMCP snapshot. A noncooperative local handler
may remain pending; the UI and docs must not promise otherwise.

## Validation contract

### VAL-CHAT-001: renderable public state

Surface: public library imports/calls.
Needs: real AgentSession with deterministic Agent Connect contract provider.
Behavior: stable snapshots between changes, immutable historical snapshots,
stable message/part ids, interleaved text/tool order, no duplicate final text;
tool errors including completions without requests; empty state; subscribe and
unsubscribe, isolated subscriber failure, no notifications after disposal.
Evidence: automated public-import tests, independent adversarial probes and a
packed-package consumer exercising a complete tool turn.

### VAL-CHAT-002: linear send/continuation and failures

Surface: public SDK plus actual ResponsesProvider through controlled HTTP fetch.
Needs: existing Open Responses fixtures, no emulated Omnigent semantics.
Behavior: validate blank inputs and reject overlapping sends before transcript
mutation; follow-ups use the retained checkpoint, never resend transcript;
known preadmission refusal preserves readiness; admitted failure loses readiness;
unknown transport outcomes never silently retry. Partial content survives errors;
missing continuation is explicit; typed errors retain status/manage URL.
Evidence: SDK/session/provider regression tests including response.created then
stream failure and refusal-before-admission; standard regression gate.

### VAL-CHAT-003: stop, disposal and local tool ownership

Surface: public AgentSession and chat calls with controlled await boundaries.
Needs: pending/late tool handler and explicit cancellation fault fixtures.
Behavior: only one iterator executes tools; stop before handler dispatch prevents
execution; stop during handler signals abort, late output is not submitted;
stop idle is harmless; repeated stop does not duplicate cancellation; cancel
failure and completion races have truthful state. Disposal is idempotent,
blocks new sends and detaches observers even if cancellation fails.
Evidence: deterministic handshakes, not sleeps; independent probes; existing
real Omnigent suite for unchanged external provider compatibility.

## Execution and evidence

### VAL-CHAT-004: portable study-note export

Surface: public library and packed npm consumer.
Needs: completed/partial conversation snapshots from actual chat calls.
Behavior: export user/assistant text as Markdown, mark noncompleted turns; optional
tool names/statuses, never argument or output bodies. No file/storage writes,
no renderer or restoration promise. User explicitly authorized this small bonus.
Evidence: export tests plus packed consumer executing tools, continuing and exporting.

### Progress

- Two sequential contract reviews completed; admission ambiguity, pre-dispatch
  stop and noncooperative local-handler limits incorporated before implementation.
- Core helper, session prerequisites, native per-task abort and Markdown export
  implemented. Public SDK tests and typecheck passed before independent review.

Runtime submit_plan/advance_project tools are unavailable here. Use this ledger,
bounded implementation ownership, two sequential contract reviews and independent
implementation/public-surface review. Check via quiet-run; final formatter once
code stabilizes. No deployment, model-allowance smoke or npm publication required.

### Final evidence (2026-09-05)

- VAL-CHAT-001–003: independent scrutiny passed. Five retained public-import
  probes in `agent-chat-review.test.ts` cover nested snapshot immutability,
  duplicate actions, subscriber-reentrant continuation, late cancellation during
  a new turn and failed disposal. Includes actual ResponsesProvider handling
  controlled HTTP responses, not fabricated Omnigent behavior.
- VAL-CHAT-004: independent export scrutiny passed; the installed npm tarball
  consumer executes tools through AgentSession, follows up via checkpoint and
  exports the resulting study notes. Export does not persist files or restore sessions.
- `npm run verify`: exit 0. Gateway 173 passed / 12 skipped, SDK 73 passed,
  real Omnigent 0.5.1 compatibility 8 passed. Typecheck, policy and build passed.
- Dedicated crash suite: 4 passed. Installed-package smoke: passed. Native
  Chrome 153 WebMCP suite: 13 passed, including headless chat stop reaching the
  real native handler signal, suppressing late output and preserving snapshot
  reuse for a new session. No real model allowance used.
- Canvas on isolated port 4177: first run 13/14, with a navigation-context
  destruction at the initial page setup before connection. Unchanged full rerun
  passed 14/14. Existing Bookhand on port 4174 was not touched. This startup
  flake was not hidden or folded into an unrelated Canvas rewrite.
- Scoped ESLint: zero errors, ten advisory complexity/size warnings. Formatter
  and diff checks are the final mechanical gates; no automatic metric-driven
  refactoring was applied.

Known boundaries: in-memory presentation only; no auth UI or durable client
checkpoint restoration. Cancellation remains cooperative; a handler can ignore
its signal, and the existing Responses transport suppresses failed remote-cancel
requests before locally aborting. Stop is not proof of remote delivery or rollback.
Images/files and optional UI packages are intentionally deferred.
