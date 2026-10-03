# Browser SDK building blocks

Status: current contract for the framework-neutral headless chat helper and the
WebMCP tool source in `@open-agent-connect/web`. Their implementation plans and
dated validation evidence are archived in
[headless chat](../archive/plans/headless-chat.md) and
[WebMCP tool source](../archive/plans/webmcp-tool-source.md).

## Headless chat

`createAgentChat({ session })` is framework-neutral: no React, DOM, rendering,
or new wire protocol. Optional UI/framework packages may consume it. The helper
owns conversation consumption of the supplied session exclusively. Connection
and authorization, WebMCP tool-source lifetime and persistence remain
application responsibilities. There is no automatic reconnect, retry, replay,
history-to-prompt reconstruction, editing/regeneration or branching.

Input is text. Images and files are deferred: do not expose an upload that
silently drops data or pretend transcript metadata is agent-visible. Actual
multimodal delivery needs a separate contract.

Public building blocks: stable immutable snapshots and subscription/unsubscribe;
ordered user/assistant messages containing text and tool-activity parts; send
(initial or explicit checkpoint continuation), stop and disposal. Assistant
messages retain partial content and completion/failure/cancellation status.
Tool failures are not whole-turn failures. Tool output bodies are not exposed by
task events and must not be invented. The helper never calls a tool.

The session exposes read-only send readiness without exposing checkpoint tokens
and protects concurrent consumption. Known pre-admission refusal stays
retryable; an unknown network outcome is not proof of non-admission.
Cancellation has a local guard before invoking a requested tool and before
submitting its late output, plus an optional tool-context `AbortSignal` for
cooperative handlers. There is no forced interruption or rollback of
JavaScript.

Stop requests cancellation; it is not instant successful completion. Completion
already observed wins. Cancellation failures remain observable and cannot
enable a second turn while the first is active. Disposal detaches UI observers,
rejects future operations and requests cancellation; it does not revoke
authorization, delete a remote session, or dispose a caller-owned WebMCP
snapshot. A noncooperative local handler may remain pending; the UI and docs
must not promise otherwise.

## WebMCP tool source

`createWebMcpToolSnapshot()` discovers native `document.modelContext` tools
owned by the current document, optionally selects names, and returns ordinary
`ApplicationTool` objects usable by the existing authorization, connection and
task APIs. Explicit application tools remain supported.

Definitions are cloned and frozen before consent. Execution stays local through
native `executeTool(registeredTool, JSON.stringify(inputObject), { signal })`.
The native string result is returned unchanged; invocation rejection follows the
existing application error path. A tool's JSON payload is not interpreted as a
new protocol envelope.

`toolchange` is observed before discovery begins. Any observed change
invalidates the whole snapshot, including during discovery. Page exit and
explicit disposal also invalidate it and abort pending native calls.
Applications dispose the snapshot when disconnecting. Abort is cooperative and
cannot undo side effects. An invalid snapshot requires rediscovery and a new
authorized connection. There is no iframe aggregation, cross-origin discovery or
testing-API fallback.

### External boundary and accepted limitation

Primary reference: the [WebMCP draft](https://webmachinelearning.github.io/webmcp/),
sections 3.1 and 4.2. Browser availability is experimental and unsupported
contexts fail clearly with `webmcp_unavailable`.

The measured native binding (Chrome 153 with experimental web platform
features) differs from the draft: schema and invocation arguments are JSON
strings, not objects. Only this measured binding is implemented; an execution is
never retried in a second format. An absent schema defaults to an object schema;
a present schema must parse to an object. A future draft binding needs its own
evidence before support is claimed.

The draft resolves execution by document and name, not registration ID. Fast
unregister/re-register can race execution before `toolchange` delivery. The
adapter prevents observed drift and never changes approved definitions; it
cannot attest immutable handler identity or sandbox a malicious page. The page
already owns its application tool implementations.
