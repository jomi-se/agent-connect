# ACP gateway spike: results

Status: in progress. Phases 0–3 of the [spike plan](../plan/acp-gateway-spike.md)
are complete. Experimental evidence, not an accepted decision.
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

## Still to answer

Q4 (holding calls open and disconnects), Q5 (browser and reconnect), Q6 and Q7
(container per session and network policy), Q8 (event traces), and the optional
live smoke.
