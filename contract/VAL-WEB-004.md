# VAL-WEB-004: Real-browser bring-your-own-agent nonce loop

Surface: browser.
Needs: VAL-WEB-001, VAL-WEB-002, VAL-WEB-003, a running Omnigent 0.5.1 server/host, an online session using Codex ACP 1.1.2, and a browser-reachable authenticated or loopback endpoint with an explicit allowed origin.
Behavior: The Canvas imports the built SDK, registers browser-owned tools, sends a task through the neutral `AgentSession` API, receives sequential tool requests from the user's Codex-backed runtime, returns their browser-owned results, and observes the same logical run complete through Open Responses continuations.
Evidence: Fresh browser interaction, screenshot, console and network review, sanitized HTTP/SSE trace, correlated handler invocations and results, visible application mutation, and final text from the real runtime.
Fail: Browser CORS/auth prevents the flow, the app imports provider wire types, the tool is not request-scoped, the handler runs more than once, the result is absent from final text, or the console/network log contains an unexplained error.
Scope: This proves one neutral SDK path over Open Responses and the internal Omnigent backend to Codex. It does not prove backend interchangeability, remote production security, or multiple underlying agents.
