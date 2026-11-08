# The lateask-cut scenario races Codex's tool listing

Status: ready-for-agent

`codex-lateask-cut` (scripts/gateway-scenarios.mjs, driven by
deploy/gateway/test/fixtures/web/drive-mobile.mjs) sends `SPIKE-LATEASK`,
waits a fixed 1.5 seconds, then freezes the page to model it going to the
background. The scenario means to test a tool call issued while the page is
away, so the agent must already know the page's tools when the page freezes.

It doesn't wait for that. Codex lists the page's tools through `mcp/message`
after the prompt arrives. When that listing reaches a page that is already
frozen, nobody answers it until the page comes back. Codex starts the turn
without the page's tools, the mock model replies `MISSING-TOOLS ask_reader`,
the turn ends, and the driver's `waitForSelector("#ask.open")` times out after
30 seconds. The gateway log shows the order: the host detaches, the agent's
turn ends with `MISSING-TOOLS ask_reader`, and the `mcp/message` answer with
the tool list goes out only at reattach.

It first showed up when the box moved to Node 26 (codex-acp runs on the box's
Node). It failed in two of the first four CI runs on Node 26 and passed in
the other two. The harness pins didn't change.

## Next step

Replace the fixed wait with a signal that the page has answered the tool
listing, for example a page event when the application tool server answers
`tools/list`. Then freeze the page. Check the fix by shortening the wait until
the old version fails every time, and confirming that the new one still passes.
