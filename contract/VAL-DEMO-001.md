# VAL-DEMO-001: Dedicated Firebase canvas accepts an agent-owned write

Surface: browser.
Needs: a dedicated Firebase Hosting project, GitHub deployment credentials, an
online OmniGENT/Codex session, and the tailnet HTTPS gateway from VAL-REMOTE-001.
Behavior: from the dedicated Firebase URL, the user starts a task and Codex
calls the page-defined `set_page_message` tool; the large visible page message
changes exactly once and the same task reaches a successful terminal response.
Evidence: GitHub deployment run and resulting stable URL; real-browser
screenshot; console and network capture covering CORS preflight, SSE, tool
result POST, and completion; page attribute showing one write; Codex response.
Fail: mocked provider output, a locally served page, a direct DOM test, or a
Firebase deploy without the live OmniGENT/Codex path cannot pass this assertion.

## Current status

Functional path passed on 2026-07-13 through the deployed Firebase page on a
Tailscale-connected mobile browser. The user-observed trace contained one
`tool.requested` and one successful `tool.completed` for `set_page_message`,
followed by text continuation and `task.completed`. The visible message was:

> Welcome—your next brilliant idea just arrived five minutes early.

The full validation assertion remains partial until an independently captured
screenshot, console/network evidence, and negative authorization probes are
recorded.
