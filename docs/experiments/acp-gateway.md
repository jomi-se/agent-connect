# ACP gateway spike: results

Status: in progress. Phases 0–6 of the [spike plan](../plan/acp-gateway-spike.md)
are complete; the live smoke (phase 7) and write-up remain. Experimental
evidence, not an accepted decision.
Code: [`experiments/acp-gateway/`](../../experiments/acp-gateway/).

## Setup (as run on 2026-09-30)

- Host: Linux arm64. Rust 1.98.1. Node 24.20.
- ACP Rust SDK crates `agent-client-protocol{,-conductor,-polyfill}` 2.2.0 and
  `agent-client-protocol-rmcp` 3.1.1, from crates.io, with no patches.
- Adapters `@agentclientprotocol/codex-acp` 2.0.1 (bundled Codex CLI 0.159.2)
  and `@agentclientprotocol/claude-agent-acp` 0.84.0 (bundled Claude Code
  2.1.284), unmodified.
- Deterministic inference: a scripted local model server that speaks the
  OpenAI Responses and Anthropic Messages streaming formats (`mock-model/`).
  Each harness runs with an isolated configuration directory. No personal
  configuration or credentials are used.

The chain under test:

```text
tool_client (plays the application: offers MCP tools over MCP-over-ACP)
  -> conductor [ PolicyProxy -> SpyProxy (tests only) -> McpOverAcpPolyfill ]
  -> codex-acp | claude-agent-acp  (child process)
```

## Answers so far

### Q1: application tools reach both harnesses in the same turn. **Pass.**

Script: the model calls `read_passage`, then `highlight` with part of the
result, then answers with text. Both harnesses completed the turn with the
adapters unmodified. The application executed each tool, and each result
returned into the same turn.

| Harness          | initialize | session ready | tool turn complete |
| ---------------- | ---------- | ------------- | ------------------ |
| codex-acp        | ~0.5 s     | ~0.8 s        | 0.5–1.1 s total    |
| claude-agent-acp | ~0.4 s     | ~0.9 s        | ~2.8 s total       |

These are mock-model timings. They measure process and protocol overhead, not
inference.

### Q2: the model sees real tools, not a dispatcher. **Pass.**

Recorded model requests:

- **Codex** receives a Responses `namespace` tool named `mcp__app`. It contains
  ordinary function tools `read_passage`, `highlight` and `ask_reader`, next to
  Codex's native `exec_command`, `web_search` and others. Codex normalizes the
  schemas: it drops `$schema`, `title`, `format` and `minimum`, and keeps
  properties, descriptions and `required`.
- **Claude Code** receives the Anthropic tools `mcp__app__read_passage`,
  `mcp__app__highlight` and `mcp__app__ask_reader`, with the application's
  JSON Schemas verbatim and not deferred.

### Q3: grant enforcement with generic ACP messages only. **Pass.**

The policy proxy (`src/policy.rs`) is default-deny in both directions. It
matches only ACP method names and the inner method of `mcp/message`. It never
inspects harness-specific events.

| Hostile application behavior                                           | Result on both harnesses                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Advertise `fs.readTextFile`, `fs.writeTextFile` and `terminal`         | Downstream sees all three `false`                                                |
| `session/new` with `cwd: "/"`                                          | Rewritten to the session scratch workspace                                       |
| Declare a `stdio` MCP server running a shell command                   | Dropped. **Baseline without the proxy: Codex executed the command on the host.** |
| Declare an `http` MCP server pointing at the cloud metadata address    | Dropped                                                                          |
| `session/set_mode`, `session/set_config_option`, unknown `_` extension | `-32601`, never reaches the adapter                                              |
| List a tool that is not in the consented snapshot                      | Removed from `tools/list`, so the model never sees it                            |
| List a consented tool name with a changed schema                       | Removed from `tools/list`                                                        |
| Deny-all permission profile                                            | Harness reports each app tool call as refused                                    |

## Findings

1. **The official polyfill is the missing piece, and it works unmodified.**
   Neither adapter supports ACP-transport MCP (`codex-acp` advertises
   `acp: false`). `McpOverAcpPolyfill::http()` rewrites the declaration to a
   loopback HTTP MCP server and advertises `acp: true` upstream. Nothing in
   the July Omnigent spike's adapter patch was needed.
2. **The gateway must choose the Codex mode.** In its default `agent` mode,
   `codex-acp` sends MCP tool calls to Codex's model-based "guardian" automatic
   review. With the mock model the review failed and the tool call failed.
   `read-only` and `workspace-write` route approval to the ACP client as
   `session/request_permission`, which the proxy answers.
   `agent-full-access` never asks. The operator selects a mode with
   `INITIAL_AGENT_MODE`. The application cannot change it, because the proxy
   denies `session/set_mode` and `session/set_config_option`.
3. **MCP protocol generations collide, and one bad message killed a session.**
   Claude Code 2.1.284's MCP client first probes with `server/discover` (MCP
   2026-07-28). The SDK 2.2.0 `rmcp`-backed server treated that as fatal ("expect
   initialized request") and tore down the whole ACP connection. The policy
   proxy's MCP method allowlist answers `-32601` instead, and Claude falls back
   to `initialize`. Any application-side MCP server, including the browser
   SDK's, must do the same. This is worth reporting upstream: an unknown
   pre-initialize method should get a method-not-found reply, not end the
   connection.
4. **Permission prompts cannot identify application tools.** Codex's prompt for
   an MCP call has an empty title, while Claude's names the tool. Telling
   application-tool prompts from native-action prompts would need
   harness-specific parsing. The authoritative application-tool gate is
   therefore `mcp/message` `tools/list` and `tools/call` against the snapshot.
   Prompts are answered from the gateway profile and never shown to the
   application.
5. **Harness-specific extensions exist.** Both adapters emit
   `_auth/status_update` notifications, which the proxy drops. Nothing
   application-facing depended on them.

### Q5: a real browser connects, survives a reload and resumes. **Pass.**

`src/bin/gateway.rs` serves ACP over WebSocket on `/acp`. `web/` is a small
reader page bundled with esbuild on top of `@agentclientprotocol/sdk` 1.5.1.
`web/drive.mjs` drives it in Playwright Chromium at phone size.

- **Authentication.** The page offers the subprotocols `acp.v1` and
  `bearer.<token>`. The gateway checks the exact `Origin` and the token,
  selects `acp.v1`, and only then spawns anything. A non-allowlisted origin and
  a wrong token were both rejected at upgrade (403 and 401), with no adapter
  process started.
- **Application tools in the page.** The TS SDK's generic
  `client().onRequest("mcp/message", …)` registration is enough to serve MCP
  from the page. There is no SDK MCP-server helper; the page implements
  `initialize`, `ping`, `tools/list` and `tools/call` in about 40 lines.
  `highlight` really wraps text in a `<mark>` in the DOM.
- **Tool turn through the browser.** Codex took 0.8 s and Claude Code 3.9 s,
  from connect to `end_turn`.
- **Human in the loop.** `ask_reader` waits for a click. A 5-second human
  answer completed on both harnesses.
- **Reload during a pending call.** The socket closes, the gateway tears down
  that connection's chain and adapter process, and nothing is replayed. A new
  turn after the reload works. No adapter processes leaked.
- **Resume.** After a reload, the page reconnects and sends `session/load` for
  its earlier session ID. The new adapter process restores the conversation:
  it replays the earlier user message, and the model's next request contained
  the earlier tool results. Then the page prompts again. This worked on both
  harnesses.
- **Session ownership.** The policy keeps a per-grant registry of session IDs
  and their workspaces. It admits `session/load` and `session/resume` only for
  those IDs, pinned to the original workspace. Loading any other ID was refused
  with `Invalid params`.

### Q4: holding an application tool call open. **Pass, with a 300 s default ceiling.**

`ask_reader` held its MCP call open for the given time before answering:

| Harness     | 50 s | 70 s | 130 s | 330 s                        |
| ----------- | ---- | ---- | ----- | ---------------------------- |
| Codex       | ok   | ok   | ok    | failed at 300 s              |
| Claude Code | —    | ok   | ok    | failed at 300 s (idle limit) |

The two limits differ in kind:

- **Codex** reports `timed out awaiting tools/call after 300s`: a hard
  per-call limit. `codex-acp` builds each session's MCP server configuration
  from the ACP declaration (URL and headers only), so neither an application
  nor the gateway can raise it per session without adapter support.
- **Claude Code** reports `sent no response or progress for 300s; aborting`
  and names `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`: an idle limit. MCP
  `notifications/progress` from the application's server resets it, and the
  policy already admits those notifications from the application.

Design consequence: application tools that wait on a person should return
within about five minutes. For longer waits, return a receipt and deliver the
answer as a later prompt. Human-in-the-loop tools in the SDK should send
progress while they wait.

Disconnect behavior is covered under Q5: the pending call dies with the adapter
process and is never replayed.

### Q8: what an application sees (partial)

Application tool calls arrive as ordinary `session/update` `tool_call` and
`tool_call_update` items. Codex titles them `mcp.app.<tool>`; Claude Code
titles them `mcp__app__<tool>`. Harness-native actions arrive the same way:

- Codex: a `tool_call` whose title is the shell command itself.
- Claude Code: a `Terminal` tool call, then an update carrying the command.

An application can render progress from these generic items without knowing
which harness it is talking to. Both harnesses also emit `usage_update`,
`session_info_update` and `available_commands_update`, which a page can ignore.

## More findings

9. **Permission prompts do not bound native actions.** Under a profile that
   rejects every prompt not attributable to an application tool, both
   harnesses still ran a native shell command with no prompt at all. Codex in
   `workspace-write` runs sandboxed commands without asking. Claude Code
   auto-allows commands it classifies as read-only. Only a sandbox bounds what
   a harness does natively.

10. **A harness does not confine itself to the session `cwd`.** The policy
    rewrites `cwd` to a per-session scratch directory, and both harnesses
    reported that directory to the model. Claude Code ran a native shell command
    there. Codex ran the same command, issued without the optional `workdir`
    argument, in the adapter's process directory instead. Confinement must come
    from the sandbox boundary (Phase 6), not from `cwd`.
11. **Claude Code auto-allows read-only shell commands.** `echo … && pwd` ran
    without a permission prompt. Only the gateway profile and sandbox, not
    prompts, can be relied on to bound native actions.
12. **Browser connection errors are opaque.** A rejected upgrade surfaces in the
    TS SDK as `[object Event]`. Browsers hide the HTTP status of a failed
    WebSocket upgrade, so an application cannot tell "wrong token" from
    "gateway down". A production gateway should accept the upgrade and close
    with an application close code and reason instead.

### Q6: a container per session is practical. **Pass.**

`sandbox/` builds one image (`node:24-bookworm-slim`, both pinned adapters,
and a Rust `session_runner`). Each session runs:

```text
docker run -i --rm --network acp-internal --read-only \
  --tmpfs /work --tmpfs /home/node --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 1536m --cpus 2 --pids-limit 512 \
  -e HTTPS_PROXY=http://egress:3128 ... acp-spike-session:dev --harness codex
```

Inside the box, `session_runner` owns the polyfill and the adapter and speaks
ACP on stdio. The host keeps only the policy proxy, so the gateway's "agent" is
simply that `docker run` command. The polyfill's loopback MCP bridge never
leaves the box. Codex runs in `agent-full-access` and Claude Code with every
prompt allowed: the box, not the harness, is the boundary.

| Boxed harness | Ready to prompt | Tool turn done | Memory mid-call |
| ------------- | --------------- | -------------- | --------------- |
| Codex         | 0.6–1.1 s       | 0.8–1.3 s      | ~83 MiB         |
| Claude Code   | 1.3–1.5 s       | 1.8–2.0 s      | ~188 MiB        |

These use mock inference; real inference adds model latency and some memory.
The image is 2.09 GB unpacked, mostly the two harness binaries and Node. Browser
sessions through a boxed gateway pass the same tool and shell scenarios. The
native shell command now reports `/work` on both harnesses, and every container
is removed when its connection closes.

### Q7: the network policy holds. **Pass, 16 of 16 probes.**

Session containers join an internal Docker network with no route out. An
egress proxy (`sandbox/egress-proxy.mjs`) sits on both that network and an
ordinary bridge. It resolves each destination, refuses the request if any
answer is private or reserved, and connects to the exact address it checked.
`sandbox/probe.sh` runs from a session-shaped container:

| Probe                                                                       | Result   |
| --------------------------------------------------------------------------- | -------- |
| Public HTTPS through the proxy                                              | 200      |
| Public HTTPS bypassing the proxy                                            | no route |
| Mock model on the internal network, direct                                  | 200      |
| Cloud metadata, RFC1918 (two), tailnet MagicDNS, the host's tailnet address | 403      |
| Loopback IPv4 and IPv6 through the proxy                                    | 403      |
| Host through the internal, egress and default bridge gateways, via proxy    | 403      |
| Host through the internal and default bridge gateways, direct               | no route |
| A public DNS name that resolves to loopback                                 | 403      |

Open design point: all sessions currently share one internal network, so
session boxes can reach each other's addresses. Nothing listens there (the
polyfill binds loopback), but a production gateway should give each session its
own internal network, with the egress proxy attached.

## Still to answer

The live smoke with real subscriptions (phase 7) and the final write-up.
