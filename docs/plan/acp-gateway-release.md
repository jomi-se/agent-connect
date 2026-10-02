# Plan: shipping the ACP gateway and its browser SDK

Status: proposed (2026-10-01). It depends on accepting
[ADR 0016](../decisions/0016-acp-application-boundary.md). Nothing here is
released, and the current release is unchanged. Evidence comes from the
[ACP gateway spike](../experiments/acp-gateway.md) and its
[mobile follow-up](acp-gateway-mobile-resume.md).

The plan covers three questions:

- how an application drives a chat over ACP;
- what `@open-agent-connect/web` must add on top of the ACP SDK, including AI
  SDK support;
- how the Rust gateway is packaged alongside the retained OpenClaw plugin.

## How a chat runs over ACP

The application page is the ACP **client**. The harness adapter
(`codex-acp`, `claude-agent-acp`) is the ACP **agent**. The gateway is an ACP
proxy between them: it authorizes the socket and filters every message. This is
the same relationship an editor such as Zed has with an agent, with the page in
the editor's place.

The client drives. One chat is:

1. **Connect.** The page opens a WebSocket to the gateway, with its grant, and
   sends `initialize`.
2. **Start.** `session/new` declares the page's tools as one MCP-over-ACP
   server. The gateway overwrites `cwd`, mode, model and every other
   authority-bearing field. The result is a `sessionId`.
3. **Send a message.** `session/prompt` carries the user's new message only.
   The harness owns the conversation history, its model, and its loop.
4. **Stream.** While the turn runs, the agent sends `session/update`
   notifications: message chunks, thought chunks, tool calls and their status,
   and plans.
5. **Application tools.** When the model calls one of the page's tools, the
   page receives an MCP `tools/call` request over the same connection, runs its
   handler, and answers it. The turn continues inside the harness. The gateway
   admits only tools in the consented snapshot.
6. **Native tools and permissions.** The harness's own tools (shell, web
   search, file edits) run inside the session box. Permission requests are
   answered by the gateway profile and never reach the page.
7. **Finish.** The `session/prompt` response carries a stop reason. Stop
   sends `session/cancel`. A later message is another `session/prompt` on the
   same session. A returning page uses `session/load`.

Open Responses works the other way round. There, a tool call ends the HTTP
response, and the caller, such as the AI SDK, runs the tool loop and sends the
result in a new request. Over ACP, the harness runs the loop, and a tool call
is a request that the page answers while the turn stays open.

The ACP TypeScript SDK (`@agentclientprotocol/sdk`) provides only the typed
JSON-RPC connection: it sends requests and dispatches the agent's requests and
notifications to handlers. It has no chat state, tool registry, schema
validation, reconnect, grant handling or error model. Those are what the
Agent Connect SDK adds.

## Browser SDK: `@open-agent-connect/web` over ACP

Applications use the Agent Connect SDK, not the ACP SDK directly. The spike
page used the ACP SDK directly, and needed about 280 lines of glue for one
chat with three tools.

**Kept as they are:** `AgentSession`, `createAgentChat`, `defineTool` and the
CSP-safe schema validation, WebMCP snapshots, `SingleMcpServer` (already an
MCP-over-ACP server) and `createBrowserAcpStream`.

**Added:**

1. **`connectAgent`.** It opens the gateway connection: a grant, the resumable
   transport (`agent-connect.resume.v1`, moved from the spike's
   `resumable-stream.js` and typed), Page Lifecycle listeners, and an ACP
   client connection. Close codes become typed errors.
2. **`AcpProvider`**, which implements the existing `AgentProvider` interface:
   - `streamTask` sends `session/new` once, then `session/prompt`;
   - `session/update` becomes `AgentProviderEvent`s (`text.delta` and the
     rest), with new event types for thoughts and plans;
   - an incoming `tools/call` becomes `tool.requested`, and
     `submitToolResult` answers the pending MCP request;
   - `cancel` sends `session/cancel`.

   `AgentSession` and `createAgentChat` then work over ACP unchanged.

3. **Recovery.** When a resumable session has ended, the SDK reconnects with
   `session/load`, reports the interrupted turn as interrupted, and never
   re-sends it.
4. **A grant client** that replaces the OpenClaw OAuth discovery. Its shape
   depends on ADR 0016's consent prerequisite.

**Retained for this implementation:** the OpenClaw plugin, connection and
conversation clients, `ResponsesProvider`, and the Open Responses AI SDK model.
Any future retirement requires a separately approved release and migration;
this branch performs no deprecation or removal.

Every ACP-facing export is labeled unstable while MCP-over-ACP is an unstable
RFD.

## AI SDK

**Today.** `createAiSdkOpenResponsesModel` presents the gateway as an AI SDK
`LanguageModel`, and `createAiSdkApplicationTools` turns application tools
into an AI SDK `ToolSet`. `streamText` therefore runs the tool loop in the
browser. Bookhand uses this path.

**Over ACP, the model layer no longer fits.** A harness is an agent with its
own loop, conversation and tools, not a model. A `LanguageModel` adapter would
have to:

- ignore the history the AI SDK re-sends on every step;
- ignore the system prompt and sampling settings;
- report tool calls the agent has already executed.

Agent Connect will not ship one.

**The UI layer fits.** AI SDK 7's `useChat` accepts a custom `ChatTransport`.
Its documentation names WebSockets as a use case. `createAcpChatTransport()`
implements it on `AcpProvider`:

| AI SDK `ChatTransport` / `UIMessageChunk`                                        | ACP                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sendMessages`, trigger `submit-message`                                         | `session/prompt` with the last user message only; `chatId` maps to the ACP `sessionId`                                                                           |
| `text-start`, `text-delta`, `text-end`                                           | `agent_message_chunk`                                                                                                                                            |
| `reasoning-start`, `reasoning-delta`, `reasoning-end`                            | `agent_thought_chunk`                                                                                                                                            |
| `tool-input-available` and `tool-output-available` with `providerExecuted: true` | `tool_call` and `tool_call_update` (the agent ran the tool; for application tools, the page's handler ran through the SDK's MCP server, not an AI SDK `execute`) |
| `data-*` part                                                                    | `plan`                                                                                                                                                           |
| `finish`, `abort`, `error`                                                       | prompt stop reason, `session/cancel`, and failures                                                                                                               |
| trigger `regenerate-message`                                                     | rejected: ACP cannot truncate a harness conversation                                                                                                             |
| `reconnectToStream`                                                              | resumable reattach, or `session/load`                                                                                                                            |

Bookhand and Firebase Canvas move to `useChat` with this transport, or to
`createAgentChat`. The tool definitions stay the same. Applications that call
a model provider directly keep using the AI SDK as before, outside Agent
Connect.

**Rejected alternative: translate ACP to Open Responses in the gateway.** This
would keep the `LanguageModel` path: the gateway would park the harness's tool
call and expose it as a turn-ending `function_call`. It brings back the
turn-ending tool model that ADR 0016 leaves. It hides harness progress, and it
adds a second application protocol for the gateway to own.

## Packaging

### What the owner installs

- The gateway: one Rust binary.
- Node 24, for the adapters: both pinned adapters
  (`@agentclientprotocol/codex-acp`, `@agentclientprotocol/claude-agent-acp`)
  are Node packages.
- The harness (Codex or Claude Code) and its login.
- Docker, only for container-per-session mode.

### Channels

- **npm (primary): `@open-agent-connect/gateway`.** The owner already has
  Node, so `npx @open-agent-connect/gateway` or a global install gives the
  matching gateway binary and pins the adapter versions it was tested with.
- **GitHub Releases:** archives and checksums per target, plus `curl | sh` and
  PowerShell installers, for owners who manage adapters themselves.
- **Homebrew tap:** later, if owners ask for it.
- **Session image** for boxed mode: published multi-architecture
  (`linux/amd64`, `linux/arm64`) to a container registry with
  `docker buildx`. Each gateway release pins it by digest.
- **crates.io:** not a consumer channel, because it distributes source only.

### Build matrix

Rust produces one binary per OS and processor. CI builds every target from
one tag, and four targets cover the expected owners:

| Target                       | Covers                                                      |
| ---------------------------- | ----------------------------------------------------------- |
| `aarch64-apple-darwin`       | Apple Silicon Macs                                          |
| `x86_64-unknown-linux-musl`  | Linux PCs and servers (static, no glibc version constraint) |
| `aarch64-unknown-linux-musl` | ARM servers and boards                                      |
| `x86_64-pc-windows-msvc`     | later; boxed mode needs Docker Desktop                      |

### Tooling

- **cargo-dist** (`dist`, maintained; 0.33.0 shipped in 2026-09). `dist init`
  generates the GitHub Actions release workflow. It builds the matrix,
  uploads release archives, and generates the shell, PowerShell, npm and
  Homebrew installers.
- **npm wrapper shape** (decided in phase 2, after testing both):
  - cargo-dist's npm installer;
  - the per-platform package pattern (one small launcher package, plus one
    package per target, selected through `optionalDependencies`).

  Some installers download every platform's package. Codex moved to platform
  builds published as dist-tags of one package to avoid that. Install size
  decides the choice.

- **Provenance:** publish from CI with npm trusted publishing (OIDC) and
  provenance, never from a workstation token. Releases attach checksums.
- **One version** for the gateway, its npm package and the session image.

### Retiring the OpenClaw plugin

After the gateway's first release, and with the owner's approval:

- run `npm deprecate @open-agent-connect/openclaw-plugin "<pointer to the
gateway>"`, and never unpublish;
- remove the plugin source from `main`; it stays in git history;
- replace the OpenClaw installation guidance in `AGENTS.md` and
  `docs/plan/current-work.md`.

Deprecation is outward-facing, so it is a separate, explicitly approved step.

## Phases

1. **Product crate.** Move the gateway from `experiments/acp-gateway/` into a
   root Cargo workspace (`crates/gateway`). Its scenario tests (the real
   adapters, a mock model, and the browser drivers) run in `npm run verify`.
2. **Packaging dry run.** Run `dist init` and a prerelease tag on a fork or
   prerelease channel. Install it on each target, including a macOS ARM CI
   runner. Choose the npm wrapper shape.
3. **SDK core.** Add `connectAgent`, the typed resumable transport,
   `AcpProvider` and recovery. Port the spike page onto the SDK. Test against
   the real gateway and adapters, with a deterministic model.
4. **AI SDK transport.** Add `createAcpChatTransport`, a `useChat` example,
   then migrate Firebase Canvas and Bookhand.
5. **Release.** Publish the gateway, the SDK and the session image. Then, with
   approval, deprecate the plugin and the OpenClaw SDK exports.

Phases 1–3 can run alongside the credential-boundary spike. Phase 5 waits for
ADR 0016's acceptance and all of its prerequisites.

## Open questions

- The binary name (`agent-connect-gateway` is the working name).
- Whether Windows is a supported owner platform for the first release.
- How a grant is issued: pairing in the gateway, or the ported OAuth consent
  code (an ADR 0016 prerequisite).
