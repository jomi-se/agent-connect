# VAL-WEB-004: Real-browser bring-your-own-agent nonce loop

Surface: browser.
Needs: VAL-WEB-001, VAL-WEB-002, VAL-WEB-003, a running Omnigent 0.5.1 server/host, an online session using Codex ACP 1.1.2, and a browser-reachable authenticated or loopback endpoint with an explicit allowed origin.
Behavior: A minimal ordinary web application imports the built SDK, registers one nonce tool, sends a task through the neutral `AgentSession` API, receives one tool request from the user's Codex-backed Omnigent session, returns the fresh browser-owned nonce, and observes the same turn complete with that nonce.
Evidence: Fresh browser interaction, screenshot, console and network review, sanitized HTTP/SSE trace, one handler invocation, one correlated result post, and final text containing the unpredictable nonce.
Fail: Browser CORS/auth prevents the flow, the app imports provider wire types, the tool is not request-scoped, the handler runs more than once, the result is absent from final text, or the console/network log contains an unexplained error.
Scope: This proves one neutral SDK path over Omnigent to Codex. It does not prove conductor interchangeability, reconnect recovery, remote production security, or multiple underlying agents.
