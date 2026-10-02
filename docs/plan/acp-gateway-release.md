# Plan: shipping the ACP gateway and its browser SDK

Status: implemented release candidate 0.1.0-alpha.1 (2026-10-02). Publication depends on accepting
[ADR 0016](../decisions/0016-acp-application-boundary.md). Nothing here is
released; the previous published OpenClaw package remains available. Evidence comes from the
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

   `AgentSession` and `createAgentChat` retain their interfaces and now forward
   thought, plan and native-tool presentation events.

3. **Recovery.** When a resumable session has ended, the SDK reconnects with
   `session/load`, reports the interrupted turn as interrupted, and never
   re-sends it.
4. **Operator grant setup.** `init` validates/copies the approved snapshot and
   creates one private exact-origin bearer config plus `{gatewayUrl, token}`
   for the app. The sample imports the grant with explicit tool consent. No
   OAuth pairing portal or automatic OpenClaw-grant migration is implemented.

**Retained for this implementation:** the OpenClaw plugin, connection and
conversation clients, `ResponsesProvider`, and the Open Responses AI SDK model.
Any future retirement requires a separately approved release and migration;
legacy SDK declarations are marked `@deprecated`, but no export is removed
and no npm package is deprecated.

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

Separately approved downstream migrations may move Bookhand and Firebase
Canvas to `useChat` with this transport, or to `createAgentChat`. The tool definitions stay the same. Applications that call
a model provider directly keep using the AI SDK as before, outside Agent
Connect.

**Rejected alternative: translate ACP to Open Responses in the gateway.** This
would keep the `LanguageModel` path: the gateway would park the harness's tool
call and expose it as a turn-ending `function_call`. It brings back the
turn-ending tool model that ADR 0016 leaves. It hides harness progress, and it
adds a second application protocol for the gateway to own.

## Packaging and installation

The gateway, SDK, platform packages and session image share version
`0.1.0-alpha.1`. Operators need only Node 24 and Docker, not a checkout or
compiler. The [install guide](../install/README.md) covers npm, checksum-verified
GitHub archives/shell installer, sample SDK tarball, private setup, dedicated
login, egress, upgrade, revoke and uninstall.

The primary npm package is a small launcher plus optional per-platform binaries.
npm selects the matching executable and records integrity without a runtime or
postinstall binary download. Adapter/native CLI versions are pinned in the
launcher metadata and matching session-image manifest; they run inside Docker
rather than being duplicated on the host. cargo-dist produces archives,
SHA-256 checksums and a shell installer. Its generated npm installer was compared
in the earlier dry run; wrapper tarball sizes were not a total disk-size comparison.

Supported targets are `aarch64-apple-darwin`, `x86_64-unknown-linux-musl`, and
`aarch64-unknown-linux-musl`. Windows is not yet supported. The session image
builds for `linux/amd64` and `linux/arm64`; published gateway binaries embed its
immutable registry digest. Local-only candidates embed the explicit local tag
and cannot be promoted by the publish script.

The [protected manual release workflow](../../.github/workflows/acp-release.yml)
uses cargo-dist's local/global split, trusted npm publishing with OIDC/provenance
and an ephemeral GHCR job token. It defaults to no-write dry runs. Actual
publication requires an accepted ADR, an already owner-pushed exact version tag
and the protected environment. Ordinary PR/main CI never publishes. See the
[release guide](../install/release.md) for setup and concrete artifact commands.

## Completed implementation

The first five phases implemented the product crate, dedicated homes/login,
local packaging, resumable SDK/provider and AI SDK chat transport.
The product-completion work then delivered, in order:

1. ACP-first SDK prerelease/exports/types/docs and retained deprecated legacy APIs;
2. packaged gateway CLI, private config/init and owned egress management;
3. installation/operator instructions using release artifacts;
4. locally validated release/PR workflows, unified versions, checksums and image builds;
5. artifact-only clean-room sample acceptance wired into `npm run verify`;
6. reconciled product/status guidance with the previous OpenClaw path retained.

The clean-room test installs the packed launcher/platform package and SDK in a
fresh container without a checkout, builds the sample through public exports,
and exercises a real pinned Codex adapter: read/highlight exactly once, reconnect
during a held app tool on the same session without duplicate submission, and Stop
without a follow-up model request. It also restores the actual browser
back/forward cache while idle and while an app tool waits, preserving the session
without replay. A gateway-only teardown gate checks owned resource removal before
fallback cleanup, including shutdown during allocation and uncertain Docker-create
responses. Release hashes are verified before installation.
It uses a deterministic model and temporary homes; it never logs in or spends
subscription allowance. Both adapters also retain their host/boxed scenario gates.
Native plan UI conversion is contract-tested; pinned fixtures expose no native
plan tool. Results are recorded in [the experiment](../experiments/acp-gateway.md).

## Owner gates and retained compatibility

Only [current-work.md](current-work.md)'s owner gates remain: live dedicated login
checks, the first approved real release/account setup, and ADR acceptance. The
initial binary name is `agent-connect-gateway`; current grant issuance is the
explicit operator snapshot/bearer handoff, not a deferred product implementation.

The OpenClaw plugin stays in the repository and on npm as the previous published
install target. Its SDK exports remain functional with `@deprecated` guidance.
Retirement, npm deprecation, removal and downstream migrations require separate
owner authorization; this plan does not schedule them. No local build authorizes
push, tags, account changes, registry publication or interactive login.
