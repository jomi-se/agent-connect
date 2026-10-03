# ACP gateway spike

Status: completed spike plan, 2026-09-30. Experimental; not an accepted decision.
Owner: gateway.
Code: `experiments/acp-gateway/`.
Results: [`docs/experiments/acp-gateway.md`](../experiments/acp-gateway.md).
Proposed decision: [ADR 0016](../../decisions/0016-acp-application-boundary.md).

## Why this spike exists

Agent Connect's goal is to let an application borrow the agent its user already
has, with the app supplying UI and tools under scoped consent. The current
release does not do that for coding harnesses:

- The plugin delegates execution to OpenClaw `POST /v1/responses`. In the
  pinned OpenClaw 2026.9.1, caller-supplied Responses `tools` are implemented
  only by the built-in `openclaw` runtime. The Codex harness does not accept
  them, so the managed agent was pinned to the built-in runtime (commit
  `b414355`).
- The managed agent denies every native tool and disables sandboxing, so the
  application reaches a model loop with its own tools and nothing else.
- OpenClaw plugin tools need names declared in the installed manifest (checked
  at registration and again when tools are resolved), so per-application tool
  names cannot travel through the plugin tool system. OpenClaw's outbound MCP
  connections carry no session identity, and an active OpenClaw sandbox
  disables Codex user MCP servers for the turn.

The root mismatch: Open Responses models an application tool as the end of a
turn, while harnesses call tools inside their loop and wait for the result.
ADR 0010 intended to keep Codex or Claude Code behind the Open Responses wire.
The OpenClaw delegation lost that.

Since ADR 0010, the Agent Client Protocol (ACP) gained what this relationship
needs. ACP is the protocol editors use to drive user-owned agents: the
application brings the UI and tools, and the user brings the agent. This spike
tests whether Agent Connect can become a consent-enforcing ACP proxy instead of
an Open Responses translator.

## Hypothesis

A browser application can speak ACP over WebSocket to a Rust Agent Connect
proxy. The application offers its tools as an MCP-over-ACP server. The proxy
enforces the grant and forwards the session through the official
MCP-over-ACP polyfill to unmodified `codex-acp` and `claude-agent-acp`
adapters. Each session runs in its own disposable container. The harness can
use its own tools freely inside that container, and application tool calls
complete inside the same turn under their real names and schemas. This needs
no fork of either adapter and no translation to Open Responses.

## Verified facts this plan relies on (2026-09-30)

| Component                                | Version                 | Relevant fact                                                                                                                                                              |
| ---------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-client-protocol` (Rust, official) | 2.2.0 (2026-09-18)      | Workspace includes `-conductor`, `-polyfill`, `-http`, `-rmcp`, `-trace-viewer`, and the `yopo` one-shot client. Apache-2.0.                                               |
| `agent-client-protocol-http`             | 2.2.x                   | `AcpHttpServer`: HTTP + SSE with WebSocket upgrade. Browser cross-origin access is off unless `CorsOptions::allow_origins`.                                                |
| `agent-client-protocol-polyfill`         | 2.2.0                   | `McpOverAcpPolyfill::http()` replaces `McpServer::Acp` declarations with loopback HTTP MCP bridges and relays `mcp/connect`, `mcp/message`, and `mcp/disconnect` over ACP. |
| `@agentclientprotocol/sdk` (TS)          | 1.5.1                   | `experimental/ws-client` uses `globalThis.WebSocket`. The schema knows `mcp/connect` and `mcp/message`, but there is no typed client-side handler for them.                |
| `@agentclientprotocol/codex-acp`         | 2.0.1 (Apache-2.0)      | Advertises `mcpCapabilities: { acp: false, http: true, sse: false }`. Depends on `@openai/codex` ^0.159.1.                                                                 |
| `@agentclientprotocol/claude-agent-acp`  | 0.84.0 (Apache-2.0)     | Advertises `mcpCapabilities: { http: true, sse: true }`. Uses the Claude Agent SDK.                                                                                        |
| ACP remote transport RFD                 | Active since 2026-07-02 | Streamable HTTP and WebSocket share the same JSON-RPC lifecycle. Authentication is layered on top. Resume uses `session/load`.                                             |
| MCP-over-ACP RFD                         | Draft, unstable         | One `mcp/message` method in each direction. The client declares `{ "type": "acp", "name", "serverId" }` in `session/new`.                                                  |

Neither adapter accepts ACP-transport MCP natively, so the polyfill is on the
critical path.

Reference implementations worth borrowing from:

- ACP UI's web build advertises no file-system capability, rejects `fs/*` with
  `-32601`, sends a `$/ping` heartbeat, and reattaches on tab focus.
- `@rebornix/stdio-to-ws` sends bearer tokens as a WebSocket subprotocol,
  because browser WebSocket constructors cannot set headers.
- OpenHands spawns the official adapters and lets each harness find its own
  login.

## Architecture under test

```text
browser page (TS ACP SDK, ws-client)
  - bearer token in a WebSocket subprotocol
  - in-page MCP server "app": read_passage, highlight, ask_reader
        |
        |  ACP over WebSocket (JSON-RPC)
        v
agent-connect spike binary (Rust, host)
  - AcpHttpServer: WebSocket upgrade, CORS for the test origin
  - per connection: session broker plus Policy proxy
        |
        |  ACP over stdio (docker run -i ...)
        v
per-session container (disposable)
  - conductor: McpOverAcpPolyfill -> codex-acp | claude-agent-acp
  - harness in full-auto mode inside the container
  - scratch workspace (tmpfs); no host mounts
  - network: internal Docker network; egress only via the policy proxy
        |
        v
egress proxy container: public internet allowed, private and reserved ranges denied
```

Application tool calls travel back up the same chain: harness to loopback HTTP
MCP bridge, then to the polyfill, then as `mcp/message` to the Policy proxy,
then over the WebSocket to the page. The page runs the tool and answers. The
harness never sees a turn boundary.

Two variants are compared, not assumed:

- **Box per session (primary).** The adapter and harness run in the container,
  and the polyfill runs next to them so its loopback bridge stays loopback.
- **Loop on host (comparison).** The adapter runs on the host and only harness
  command execution is confined, using the harness's native sandbox. This keeps
  login credentials out of the box. It is only compared where it affects the
  decision.

## Questions and pass criteria

| #   | Question                                                                                                                | Pass                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Does a tool offered by the page reach each harness through the polyfill, and does its result return into the same turn? | Both adapters, unmodified, complete call → result → final text under deterministic inference.                                                    |
| Q2  | What does the model actually see?                                                                                       | Recorded model requests show each tool under a real name (for example `mcp__app__read_passage`) with its original JSON Schema. Not a dispatcher. |
| Q3  | Can the proxy enforce the grant using generic ACP messages only?                                                        | Every rule in the policy table below has a passing negative test, with no harness-specific parsing.                                              |
| Q4  | How long can a call stay open, and what happens when the tab goes away?                                                 | Measured default timeouts per harness. On disconnect, the harness gets an error and the call is never replayed.                                  |
| Q5  | Does a browser connect, survive a reload, and resume?                                                                   | Playwright Chromium: connect, tool round trip with DOM effect, reload, `session/load` or a documented failure.                                   |
| Q6  | Is a container per session practical?                                                                                   | Cold and warm start time, idle and active memory per session, measured with both adapters.                                                       |
| Q7  | Does the network policy hold?                                                                                           | From inside a session: public HTTPS through the proxy works. Direct egress and private, link-local, loopback, CGNAT and metadata addresses fail. |
| Q8  | What will an application UI receive?                                                                                    | Captured `session/update` traces for text, thoughts, plans, tool calls and harness-native actions from both harnesses.                           |

Kill criteria. Stop and reassess if any of these happens:

- Either adapter needs a fork or patch to receive application tools. This is
  the July `codex-acp` approval problem again.
- Grant enforcement needs harness-specific event parsing.
- A container session costs more than about 10 s cold start or 1.5 GiB
  resident memory. In that case, fall back to evaluating the loop-on-host
  variant.

## Policy proxy rules

The application is untrusted. It can speak ACP only through this proxy, and
the proxy owns every field that grants authority. The effective authority stays
the intersection of the application grant, gateway profile, harness policy and
container boundary (see the
[threat model](../../research/2026-07-14-malicious-application-runtime-threat-model.md)).

| Message                                                        | Rule                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize` (from app)                                        | Force client capabilities to `fs.readTextFile=false`, `fs.writeTextFile=false`, `terminal=false`. Strip unknown capabilities.                                                                                                                          |
| `session/new`                                                  | Replace `cwd` with the session scratch directory. Allow exactly one MCP server, `type: "acp"`, with the configured name `app`. Drop any other server. A `stdio`, `http` or `sse` server from an application would mean host command execution or SSRF. |
| `session/load`, `session/resume`                               | Only session IDs created by this connection's grant.                                                                                                                                                                                                   |
| `session/set_mode`, `set_model`, `providers/*`, config options | Reject. The operator chooses harness mode and model.                                                                                                                                                                                                   |
| `_`-prefixed extension methods and anything unknown (from app) | Reject with `-32601`.                                                                                                                                                                                                                                  |
| `fs/*`, `terminal/*` (from agent)                              | Reject with `-32601`, as ACP UI does.                                                                                                                                                                                                                  |
| `session/request_permission` (from agent)                      | Never shown to the app. Allow a call to a granted application tool. Answer harness-native actions from the gateway profile (the spike profile allows everything inside the container). Deny everything else.                                           |
| `mcp/connect` (toward app)                                     | Only for the `app` server declared in this session.                                                                                                                                                                                                    |
| `mcp/message` `tools/list` result (from app)                   | Keep only tools in the consented snapshot whose schemas match exactly. Drop the rest and log it.                                                                                                                                                       |
| `mcp/message` `tools/call` (toward app)                        | Only granted tool names. Assign a stable action ID, and never retry automatically.                                                                                                                                                                     |
| Other `mcp/message` methods                                    | Allow `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, cancellation and `ping`. Reject resources, prompts, sampling and elicitation for now.                                                                                     |

The spike uses a static development bearer token and a fixed tool snapshot. The
real OAuth and grant flow (already implemented in TypeScript) is out of scope.
The spike only has to show where the grant check plugs in.

## Deterministic inference

Following the [testing strategy](../../architecture/testing-strategy.md), the
spike runs the real adapters and harnesses against scripted local model
providers:

- **Codex:** an isolated `CODEX_HOME` whose `config.toml` selects a custom
  `model_provider` with `wire_api = "responses"` pointing at a mock Responses
  server.
- **Claude Code:** an isolated `CLAUDE_CONFIG_DIR`, with `ANTHROPIC_BASE_URL`
  pointing at a mock Messages server and a dummy key.

Each mock:

- follows a script:
  1. find the offered tool whose name ends in `read_passage` and call it;
  2. after the result, call `highlight`;
  3. then answer with text echoing the tool result.
- tolerates side calls such as titling and token counting;
- records every request as JSONL. That record is the evidence for Q2.

The spike never uses personal Codex or Claude configuration. It never copies
credentials into a container or into the repository. An optional live smoke
(phase 7) uses the owner's existing logins in place, on the host, and needs the
owner's explicit go-ahead at that point.

## Phases

Each phase ends in a commit on `spike/acp-gateway`, and findings go into the
results doc as they land.

0. **Setup.** User-local Rust toolchain (rustup, stable ≥ 1.88). Create the
   Cargo workspace in `experiments/acp-gateway/` with the ACP crates pinned to
   2.2.x. Pin adapter versions in a small `package.json` under the experiment
   directory. It is not an npm workspace member.
   _Exit:_ `cargo build` passes, and `yopo` runs.
1. **Mock providers.** Scripted Responses and Messages mocks. Run each adapter
   against its mock with `yopo`, with no tools.
   _Exit:_ both adapters finish a plain prompt against their mock, with isolated
   configuration directories.
2. **Tool path without a browser.** A Rust test client declares an `acp` MCP
   server with the three tools. Chain: polyfill, then adapter. Run the scripted
   tool turn.
   _Exit:_ Q1 and Q2 answered for both harnesses, with the tool names and
   schemas the model saw recorded.
3. **Policy proxy.** Implement the rules above as a proxy component. Negative
   tests: stdio or HTTP MCP injection, host `cwd`, `fs` capability, `set_model`,
   an unapproved tool call, extra tools in `tools/list`, schema drift, and
   permission requests.
   _Exit:_ Q3.
4. **Browser.** WebSocket server with CORS and subprotocol bearer. A test page
   bundled with esbuild: TS SDK ws-client plus an in-page MCP server. The page
   answers `mcp/connect` and `mcp/message` itself if the SDK has no handler.
   Drive it with Playwright Chromium.
   _Exit:_ Q5, the round trip and DOM highlight; also Q8 traces.
5. **Holding calls open and disconnects.** `ask_reader` waits for a click.
   Find each harness's default MCP tool timeout and whether a session can set
   it. Close the tab mid-call and observe. Reload and resume.
   _Exit:_ Q4.
6. **Container per session.** Image built from pinned adapters plus the
   polyfill and conductor (built for the host architecture). Launch with
   `docker run -i` and:
   - `--read-only`, a tmpfs workspace, and a non-root user;
   - `--cap-drop ALL` and `no-new-privileges`;
   - memory, CPU and PID limits;
   - an internal network, with an egress proxy container that denies private
     and reserved destinations after DNS resolution.

   The mock providers run on the internal network. Measure start time and
   memory, and run the network probes.
   _Exit:_ Q6 and Q7.

7. **Live smoke (owner go-ahead required).** Loop-on-host variant with the
   owner's existing logins in place. Run one short Bookhand-like prompt per
   harness that uses the harness's own web search plus one application tool.
   Record the event trace, not the content.
   _Exit:_ one real composition per harness, or a documented blocker.
8. **Write-up.** Results doc with answers, measurements, traces summarized,
   and what broke. If Q1–Q3 pass, draft ADR 0016 (status: proposed): "ACP
   application boundary". It would supersede ADR 0010's wire and ADR 0015's
   execution host. Add a pointer from [current work](../../plan/current-work.md).

## Out of scope

- Changes to published packages, the OpenClaw plugin, Bookhand, or any live
  deployment, ingress, DNS or tunnel.
- Porting OAuth/PKCE, consent pages or grant storage. The spike stubs them.
- Durable sessions across gateway restarts, multi-user hosting, billing.
- The credential boundary for box-per-session with real subscriptions, such as
  an egress proxy that injects credentials. Phase 6 uses mocks only; the
  results doc lists options for a follow-up.
- Performance tuning beyond measuring.

## Risks and fallbacks

| Risk                                                              | Fallback                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The polyfill does not fit an adapter (bridge address, lifecycle)  | The proxy hosts the HTTP MCP bridge itself with `agent-client-protocol-rmcp`. Record why.                    |
| The TS SDK cannot handle `mcp/*` on the client side               | Raw JSON-RPC handling in the page. Report upstream.                                                          |
| Codex asks approval for each application tool (July behavior)     | Answer through `session/request_permission` in the proxy. It is a normal ACP flow now, not an adapter patch. |
| Unstable ACP features change                                      | Pin exact versions. Label all MCP-over-ACP use as unstable, per AGENTS.md.                                   |
| Harness login refresh or telemetry needs endpoints the mock lacks | Isolated configuration plus explicit mock stubs. Record every unexpected endpoint.                           |
| The arm64 host lacks an image or binary                           | Build inside Docker multi-stage. Record it.                                                                  |
