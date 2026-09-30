# ACP gateway spike: results

Status: complete, 2026-09-30. Experimental evidence for the
[spike plan](../plan/acp-gateway-spike.md), not an accepted decision. The
proposed decision is [ADR 0016](../decisions/0016-acp-application-boundary.md).
Code: [`experiments/acp-gateway/`](../../experiments/acp-gateway/).

## Verdict

The hypothesis holds. A browser application can speak ACP over WebSocket to a
Rust Agent Connect gateway and offer its own tools over MCP-over-ACP. The
gateway enforces the grant with generic ACP messages and forwards the session
through the official polyfill to **unmodified** `codex-acp` and
`claude-agent-acp`. Each session can run in its own disposable container.

Both harnesses:

- call application tools under their real names, with real schemas, within one
  turn;
- use their own native tools (web search, shell) alongside the application
  tools;
- resume a session after a browser reload.

Real-subscription runs of Codex and Claude Code each completed a reader-style
turn: application tool, native web search, application tool, cited answer.

Nothing in the chain translates to or from Open Responses, and no adapter was
patched.

The central open problem is the **credential boundary**: how a purpose-built,
per-session harness configuration uses the owner's subscription login without
copying it and without exposing it to the harness's own tools.

## Setup (as run on 2026-09-30)

- Host: Linux arm64. Rust 1.98.1. Node 24.20. Docker 29.2.
- ACP Rust SDK: `agent-client-protocol{,-conductor,-polyfill}` 2.2.0 and
  `agent-client-protocol-rmcp` 3.1.1, from crates.io, unpatched.
- Browser SDK: `@agentclientprotocol/sdk` 1.5.1.
- Adapters, unmodified: `@agentclientprotocol/codex-acp` 2.0.1 (Codex CLI
  0.159.2) and `@agentclientprotocol/claude-agent-acp` 0.84.0 (Claude Code
  2.1.284).
- Deterministic inference: `mock-model/server.mjs`, a scripted server that
  speaks the OpenAI Responses and Anthropic Messages streaming formats and logs
  every request. Each harness gets an isolated configuration directory.
- Real inference (phase 7 only): the owner's existing Codex (ChatGPT) and
  Claude logins, used in place on the host.

```text
browser page (TS ACP SDK; serves MCP tools "app" in the page)
  │  ACP over WebSocket, subprotocols acp.v1 + bearer.<token>, exact Origin
  ▼
gateway (Rust): per connection → PolicyProxy ─┬─ host:  McpOverAcpPolyfill → adapter
                                               └─ boxed: docker run -i … session_runner
                                                          [McpOverAcpPolyfill → adapter]
```

## Answers

### Q1: do application tools reach both harnesses in the same turn? Pass.

The mock model calls `read_passage`, then `highlight` with part of the result,
then answers. Both adapters, unmodified, completed call, result and final text
in one turn.

| Harness          | initialize | session ready | tool turn complete |
| ---------------- | ---------- | ------------- | ------------------ |
| codex-acp        | ~0.5 s     | ~0.8 s        | 0.5–1.1 s          |
| claude-agent-acp | ~0.4 s     | ~0.9 s        | ~2.8 s             |

### Q2: what does the model actually see? Real tools, not a dispatcher. Pass.

- **Codex** receives a Responses `namespace` tool named `mcp__app`. It contains
  ordinary function tools `read_passage`, `highlight` and `ask_reader`, next to
  Codex's native `exec_command`, `web_search` and others. Codex normalizes the
  schemas: it drops `$schema`, `title`, `format` and `minimum`.
- **Claude Code** receives `mcp__app__read_passage` and the others with the
  application's schemas verbatim. With the owner's real configuration, Claude
  Code deferred them behind `ToolSearch` and discovered them before calling;
  they were still individually named tools.

### Q3: can the proxy enforce the grant with generic ACP messages only? Pass.

`src/policy.rs` is default-deny in both directions. It matches ACP method names
and the inner method of `mcp/message`, and nothing harness-specific.

| Hostile application behavior                                        | Result on both harnesses                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| Advertise `fs` read/write and `terminal`                            | Downstream sees them `false`                                   |
| `session/new` with `cwd: "/"`                                       | Rewritten to the session workspace                             |
| Declare a `stdio` MCP server running a shell command                | Dropped. **Without the proxy, Codex executed it on the host.** |
| Declare an `http` MCP server at the cloud metadata address          | Dropped                                                        |
| `session/set_mode`, `session/set_config_option`, unknown `_` method | `-32601`                                                       |
| List a tool that is not in the consented snapshot                   | Removed from `tools/list`                                      |
| List a consented name with a changed schema                         | Removed from `tools/list`                                      |
| `session/load` of a session this grant did not create               | `Invalid params`                                               |
| Deny-all permission profile                                         | Harness reports the tool calls as refused                      |

### Q4: how long can a call stay open? Up to 300 s by default.

`ask_reader` holds its MCP call open before answering.

| Harness     | 50 s | 70 s | 130 s | 330 s                                         |
| ----------- | ---- | ---- | ----- | --------------------------------------------- |
| Codex       | ok   | ok   | ok    | fails at 300 s                                |
| Claude Code | —    | ok   | ok    | fails at 300 s; ok with the idle limit raised |

- **Codex:** `timed out awaiting tools/call after 300s`, a hard per-call limit.
  `codex-acp` builds each session's MCP configuration from the ACP declaration
  (URL and headers only), so the limit cannot be raised per session today.
- **Claude Code:** `sent no response or progress for 300s`, an idle limit.
  Setting `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` raises it (a 330 s call then
  completed), and MCP `notifications/progress` resets it. The policy admits
  those notifications from the application.
- **Disconnect:** a pending call dies with the adapter process and is never
  replayed (see Q5).

### Q5: does a real browser connect, survive a reload and resume? Pass.

Covered in Playwright Chromium at phone size (`web/drive.mjs`):

- **Authentication.** The gateway checks the exact `Origin` and a bearer token
  offered as a WebSocket subprotocol, then selects `acp.v1`. A wrong origin
  (403) and a wrong token (401) were both refused before any process started.
- **Tools served by the page.** The TS SDK's generic
  `client().onRequest("mcp/message", …)` is enough to serve MCP from a page.
  The page implements `initialize`, `ping`, `tools/list` and `tools/call` in
  about 40 lines, and `highlight` inserts a real `<mark>`.
- **Tool turn.** Codex took 0.8 s and Claude Code 3.9 s, from connect to
  `end_turn`.
- **Human in the loop.** `ask_reader` waits for a click. A 5 s human answer
  completed on both harnesses.
- **Reload during a pending call.** The chain and adapter process are torn
  down, nothing is replayed, the next turn works, and no process leaks.
- **Resume.** After a reload, `session/load` in a fresh adapter process
  restored the conversation. The next model request contained the earlier
  tool results. This worked on both harnesses.

### Q6: is a container per session practical? Pass.

The gateway's "agent" is simply `docker run -i … session_runner`. Inside the
box, `session_runner` (Rust) owns the polyfill and the adapter, so the
polyfill's loopback MCP bridge never leaves the box. The box has a read-only
root, tmpfs `/work`, home and `/tmp`, runs as a non-root user with all
capabilities dropped, and is capped at 1.5 GiB of memory, 2 CPUs and 512 PIDs.
The harness runs in its full-access mode: the box is the boundary.

| Boxed harness | Ready to prompt | Tool turn done | Memory mid-call |
| ------------- | --------------- | -------------- | --------------- |
| Codex         | 0.6–1.1 s       | 0.8–1.3 s      | ~83 MiB         |
| Claude Code   | 1.3–1.5 s       | 1.8–2.0 s      | ~188 MiB        |

The image is 2.09 GB unpacked. Browser sessions through a boxed gateway pass
the tool and shell scenarios. Native shell commands report `/work`, and every
container is removed when its connection closes.

### Q7: does the network policy hold? Pass, 16 of 16 probes.

Boxes join an internal Docker network with no route out. Their only exit is
`sandbox/egress-proxy.mjs`. It resolves each destination, refuses the request
if any answer is private or reserved, and connects to the exact address it
checked.

| Probe from inside a box                                         | Result   |
| --------------------------------------------------------------- | -------- |
| Public HTTPS through the proxy                                  | 200      |
| Public HTTPS bypassing the proxy                                | no route |
| Mock model on the internal network                              | 200      |
| Metadata, RFC1918, tailnet MagicDNS, the host's tailnet address | 403      |
| Loopback IPv4 and IPv6 through the proxy                        | 403      |
| The host via each Docker bridge gateway, through the proxy      | 403      |
| The host via bridge gateways, direct                            | no route |
| A public name resolving to loopback                             | 403      |

### Q8: what does an application see? Generic progress, no harness knowledge needed.

Application and native tool calls both arrive as `session/update`
`tool_call` and `tool_call_update` items:

- Codex titles app tools `mcp.app.<tool>`, and titles shell calls with the
  command itself. Its hosted search appears as "Web search".
- Claude Code titles app tools `mcp__app__<tool>`, shell as `Terminal`, and
  also shows "Web search" and `ToolSearch`.

Text streams as `agent_message_chunk`. Both harnesses also emit
`usage_update`, `session_info_update` and `available_commands_update`. A reader
UI can render "reading chapter 1 → searching the web → highlighting" from these
items alone.

### Phase 7: real subscriptions, host loop. Pass.

Each harness ran once, on the host, with the owner's login in place and a
clean process environment. The prompt: read chapter 1 with the app tool, do
one web search, highlight the first sentence with the app tool, answer in three
sentences with a source.

| Harness     | Mode                                          | Duration | Sequence observed                                                              |
| ----------- | --------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| Codex       | `read-only`, gateway profile `app-tools-only` | 25 s     | `read_passage` → native Web search → `highlight` → cited answer                |
| Claude Code | default, gateway profile `app-tools-only`     | 19 s     | `ToolSearch` → `read_passage` → native Web search → `highlight` → cited answer |

Both highlighted exactly "Chapter 1: The validation set is not the test set."
Codex asked the gateway to approve each application tool call, and the proxy
allowed them as application tools. Claude Code asked nothing (finding 10).

## Findings

1. **The official polyfill is the missing piece, and it works unmodified.**
   Neither adapter accepts ACP-transport MCP. `McpOverAcpPolyfill::http()`
   bridges it to loopback HTTP and advertises `acp: true` upstream. The July
   Omnigent adapter patch is not needed.
2. **The gateway must choose the harness mode.** In its default `agent` mode,
   `codex-acp` sends MCP tool calls to Codex's model-based guardian review.
   `read-only` and `workspace-write` route approval to the ACP client, and
   `agent-full-access` never asks. The operator chooses the mode, and the proxy
   denies mode changes from the application.
3. **MCP protocol generations collide.** Claude Code's MCP client probes with
   `server/discover` (MCP 2026-07-28). The SDK's `rmcp`-backed server treated
   that as fatal and tore down the whole ACP connection. Answering `-32601`,
   as the policy does, makes Claude fall back to `initialize`. Every
   application-side MCP server must do the same. This is worth reporting to
   the Rust SDK.
4. **Permission prompts cannot identify application tools generically.**
   Codex's MCP prompt has an empty title. The authoritative gate for
   application tools is therefore `tools/list` and `tools/call` against the
   snapshot. The host-only `app-tools-only` profile attributes prompts through
   adapter-specific titles.
5. **Permission prompts do not bound native actions.** Under
   `app-tools-only`, both harnesses still ran a shell command without asking:
   Codex's sandboxed commands, and Claude's commands classified as read-only.
6. **A harness does not confine itself to the session `cwd`.** Codex ran a
   shell command, issued without the optional `workdir`, in its process
   directory rather than the session `cwd`. Only a sandbox boundary confines
   native actions; in a box, that directory is `/work`.
7. **Browser connection failures are opaque.** Browsers hide the HTTP status
   of a failed WebSocket upgrade, and the SDK reports `[object Event]`. A
   production gateway should accept the upgrade and close with an application
   close code and reason.
8. **Harness-specific extensions exist.** Both adapters emit
   `_auth/status_update`, which the proxy drops without consequence.
9. **Tool-call ceilings are about five minutes** (Q4). Human-in-the-loop tools
   should send MCP progress while they wait, or return a receipt and deliver
   the answer as a later prompt.
10. **Using the owner's configuration in place imports their posture.** The
    owner's Claude Code settings select `auto` permission mode, so Claude
    approved application tools and web search itself and never asked the
    gateway. Codex, in the gateway-chosen mode, did ask. A production gateway
    must launch harnesses with a purpose-built configuration whose mode it
    controls, which leads directly to the credential boundary below.

## Open problems for a follow-up

- **The credential boundary.** Purpose-built configuration means the
  subscription login must reach a per-session home without being copied and
  without being readable by the harness's own shell. Refresh tokens rotate:
  copying or symlinking a login file into another directory can silently log
  out the owner's other sessions. Candidate designs are an egress proxy that
  injects credentials, or keeping the loop on the host with every native
  action routed into the box. Both need their own spike.
- **Per-session networks.** Boxes currently share one internal network. Give
  each session its own internal network, with the egress proxy attached.
- **Durable boxed sessions.** tmpfs homes lose harness history when a box
  exits, so `session/load` across reconnects works only on the host variant. A
  per-grant session volume is the likely shape.
- **SDK ergonomics.** A small MCP-server helper for the browser SDK (tool
  registry, method-not-found for unknown methods, progress while waiting) and
  close-code errors instead of opaque events.
- **Upstream reports.** The `rmcp` pre-initialize failure (finding 3), and a
  way to pass MCP tool timeouts through `codex-acp` session setup.

## Reproduce

See [`experiments/acp-gateway/README.md`](../../experiments/acp-gateway/README.md).
