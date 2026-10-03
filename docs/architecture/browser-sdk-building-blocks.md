# Browser SDK building blocks

`@open-agent-connect/web` exposes the experimental ACP root API. Browser chat
uses `connectAgent`, `createAcpChatTransport` and AI SDK `useChat`. The transport
executes approved application tools internally, validates arguments using
CSP-safe JSON Schema and presents harness updates without a second model loop.
It accepts only an explicit latest user message, never replayed UI history.

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
