# VAL-JUDGE-004: The deterministic ACP fixture performs the real dynamic tool loop

Surface: browser, API, and protocol artifact.
Needs: VAL-JUDGE-003, the one-container judge demo with an online Omnigent
host, and the deterministic ACP agent configured as the only harness.
Behavior: Firebase Canvas sends a task through the public Agent Connect API;
Omnigent provisions the deterministic ACP runner; that runner initializes the
request-scoped MCP relay, lists the advertised tools, reads current page state,
selects the disclosed prerecorded plan for the chosen demo app, calls only
tools from the fixed ten-tool snapshot, receives each browser result, and
completes with visible page mutations. The UI and testing instructions label
the runtime deterministic rather than Codex/model powered. Prompt text is
bounded input to deterministic plan selection, not executable shell or model
input.
Evidence: clean-browser screenshot and event trace, gateway/Omnigent health,
and sanitized ACP/MCP transcript containing initialize, session/new,
session/prompt, tools/list, tools/call, correlated result, and completion.

Fail: the page is hardcoded to mutate without the protocol loop, another tool
can be selected, prompt text becomes executable input, or the sandbox is
described as a model.
Scope: the action plans were authored from real Codex interactions but are not
live model reasoning.
