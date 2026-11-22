# Application tools fail to start on adapters newer than ACP SDK 2.6

Status: ready-for-agent

With `@agentclientprotocol/codex-acp` 2.8.0 and Codex 0.170, a boxed Codex
session never sees the application's tools. The startup notice reads:

```text
MCP server `app` failed to start: MCP client for `app` failed to start:
MCP startup failed: handshaking with MCP server failed:
JSON-RPC error: -32020: Method not found
```

and the mock model answers `MISSING-TOOLS`. The boxed and clean-room CI gates
failed this way from 2026-11-22; the last green run (2026-11-16) had
codex-acp 2.6.0 with Codex 0.166. Claude fails the same way ("MCP server
"app" failed to start") from claude-agent-acp 0.107.1, its first release on
ACP SDK 2.7, whatever the Claude Code version: 0.107.0 passes with Claude
Code 2.1.330, and 0.108.0 fails with 2.1.325, 2.1.326 and 2.1.328.

Two things changed at once:

1. **Codex 0.170 and Claude Code open with MCP `server/discover`** (MCP
   2026-07-28) before `initialize`. The policy proxy refuses it on purpose (it is not in
   `MCP_REQUESTS_TO_APP`), so that clients fall back to `initialize`.
2. **The MCP-over-ACP binding after ACP SDK 2.6** (codex-acp bridges `acp`
   servers to local HTTP with `toHttp()`) expects an inner MCP error to travel inside a
   successful `mcp/message` response, as `{ "error": { code, message } }`,
   and a success as `{ "result": … }`. An ACP-level error becomes a binding
   failure, so Codex gives up instead of falling back. The browser SDK still
   answers `mcp/message` with bare MCP results on ACP SDK 1.3, which the new
   binding would also reject as an invalid carrier.

Until this is fixed, the box holds codex-acp below 2.8 and claude-agent-acp
below 0.107.1, the last releases on ACP SDK 2.6 (`ADAPTER_CEILINGS` in
`crates/gateway/src/operations/box_build.rs`, and the same in
`deploy/gateway/box/install-harnesses.sh` for checkout builds). Codex follows
the release its adapter accepts. An owner pin in `versions.json` still wins.

## Next step

Move the browser SDK to the ACP SDK release codex-acp uses and answer
`mcp/message` with the response carrier. Have the policy proxy refuse an
unlisted inner method with an inner MCP method-not-found in that carrier,
or admit `server/discover` with a fixed answer. Remove the ceilings, and check
the fix by running the boxed gate on the newest adapters, which fail today
with the errors above.
