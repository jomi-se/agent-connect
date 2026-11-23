# Browser SDK building blocks

`@open-agent-connect/web` exposes the experimental ACP client API from its
package root with no Node-only runtime imports. Its layers map directly onto
the [narrow protocol profile](narrow-protocol-profile.md):

- **Pairing and grants:** `createAcpPairing` and `captureAcpPairingCallback`
  run PAR + OAuth code + S256 PKCE against the user's chosen gateway origin,
  keeping rotating access/refresh tokens out of URLs.
- **Connection and resumption:** `connectAgent` (`AcpProvider`) and
  `createResumableAcpStream` manage the WebSocket attachment, sequence
  reattachment across transient drops, BFCache liveness checks and explicit
  `provider.recover()` history loading after ended sessions.
- **Application tools:** `defineTool` and `SingleMcpServer` validate arguments
  with CSP-safe JSON Schema, pass each tool's stable action ID and abort signal
  to the handler, and return structured MCP results.
- **Chat UI transport:** `createAcpChatTransport` plugs into AI SDK `useChat`
  at the UI layer, executing approved application tools internally without a
  second model loop and sending only the explicit latest user message (never
  replaying UI history).

See the [browser SDK README](../../packages/web-sdk/README.md) for usage
examples and error codes.

## WebMCP tool source

`createWebMcpToolSnapshot()` discovers native `document.modelContext` tools
owned by the current document, optionally selects names, and returns ordinary
`ApplicationTool` objects usable by `connectAgent` and
`createAcpChatTransport`. Explicit application tools remain supported.

Definitions are cloned and frozen before consent. Execution stays local through
native `executeTool(registeredTool, inputObject, { signal })`, passing the
browser's own `Tool` object (a copy is refused).
The native string result is returned unchanged; invocation rejection follows
the existing application error path. A tool's JSON payload is not interpreted
as a new protocol envelope.

`toolchange` is observed before discovery begins. Any observed change
invalidates the whole snapshot (`webmcp_snapshot_invalidated`), including
during discovery. Page exit (`pagehide`), caller abort and explicit disposal
also invalidate it and abort pending native calls. Applications dispose the
snapshot when disconnecting. Abort is cooperative and cannot undo side effects.
An invalid snapshot requires rediscovery and a new authorized connection. There
is no iframe aggregation, cross-origin discovery or testing-API fallback.

### External boundary and accepted limitation

Primary reference: the
[WebMCP draft](https://webmachinelearning.github.io/webmcp/), sections 3.1 and
4.2. Browser availability is experimental and unsupported contexts fail clearly
with `webmcp_unavailable`.

The measured native binding (Chromium 159 with experimental web platform
features) matches the draft: schema and invocation arguments are objects, and
the result is a string. Chrome 153 passed JSON strings instead; that binding is
no longer supported. Only the measured binding is implemented; an execution is
never retried in a second format. An absent schema defaults to an object
schema; a present schema must be an object. A future binding needs its own
evidence before support is claimed.

The draft resolves execution by document and name, not registration ID. Fast
unregister/re-register can race execution before `toolchange` delivery. The
adapter prevents observed drift and never changes approved definitions; it
cannot attest immutable handler identity or sandbox a malicious page. The page
already owns its application tool implementations.
