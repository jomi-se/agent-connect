# VAL-JUDGE-004: The deterministic ACP fixture performs the real dynamic tool loop

Surface: browser, API, and protocol artifact.
Needs: VAL-JUDGE-003, the one-container judge appliance with an online OmniGENT
host, and the deterministic ACP agent configured as the only harness.
Behavior: Firebase Canvas sends a task through the public Agent Connect API;
OmniGENT provisions the deterministic ACP runner; that runner initializes the
request-scoped MCP relay, lists the advertised tools, selects only
`set_page_message`, calls it with an allowlisted fixed argument, receives the
browser result, and completes the turn with a visible page mutation. The UI and
testing instructions label the runtime deterministic rather than Codex/model
powered. For the minimum profile, arbitrary prompt text is recorded only as
bounded task input and ignored by tool selection; the exact fixed message is
declared in the deterministic-agent fixture and test.
Evidence: clean-browser screenshot and event trace, gateway/OmniGENT health,
and sanitized ACP/MCP transcript containing initialize, session/new,
session/prompt, tools/list, tools/call, correlated result, and completion.

Fail: the page is hardcoded to mutate without the protocol loop, another tool
can be selected, prompt text becomes executable input, or the sandbox is
described as a model.
Scope: disclosed regex or recorded-action polish is deferred until this fixed
behavior passes.
