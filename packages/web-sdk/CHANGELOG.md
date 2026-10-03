# Changelog

## 0.1.0-alpha.1

Prepared experimental ACP release; publication is a separate action.

- Add the `@open-agent-connect/web/acp` entry point for `connectAgent`,
  `AcpProvider`, `createAcpChatTransport`, resumable/browser streams, recovery
  types, application tools and shared session/chat helpers.
- Add unstable hosted browser pairing, callback capture and session-scoped managed
  grants with exact-origin S256 PKCE, serialized rotating refresh and revocation.
  Explicit user action opens consent; recovery never replays uncertain turns.
- Handle terminal supersession and the 1 MiB serialized frame limit, preserve MCP
  progress metadata and leave healthy idle transports attached.
- Expose `BrowserAcpStream` alongside its options at both public entry points.
- Document fixed application tools, AI SDK `useChat`, cancellation, history
  recovery, typed close codes and uncertainty after interrupted effects.
- Mark ACP, MCP-over-ACP and native WebMCP APIs experimental in declarations.
  Agent Connect's resume framing is a custom extension, not an ACP standard.
- Preserve all root OpenClaw discovery/authorization/token/storage helpers,
  conversation/history helpers, `ResponsesProvider`,
  `createOpenClawResponsesProvider`, Open Responses AI SDK model/continuation/
  checkpoint/tool adapters and their types. Mark those declarations deprecated
  with ACP alternatives; this alpha removes no compatibility export and does
  not automatically migrate grants or conversations.
- Package JavaScript and declarations without tests, declaration maps or source
  maps. Check clean tarball runtime imports and public ACP types, including
  recovery handles, while retaining the existing OpenClaw package smoke.

## 0.0.9

Previous version of the browser SDK with the OpenClaw plugin / Open Responses
integration. This entry records the compatibility baseline without restating
historical release contents.
