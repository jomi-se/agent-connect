# VAL-RESP-004: A fresh browser session completes a real Codex tool loop

Surface: browser, API, real agent runtime.
Needs: the Firebase Canvas, the private Tailscale Serve profile, the real
gateway and Omnigent stack, and a subscription-authenticated Codex runtime.
Behavior: with local and session storage cleared, a first-time browser visitor
uses the Open Responses wire, verifies the gateway, completes consent for
the exact tool snapshot, and returns from authorization still on that wire. A
single task causes real Codex to inspect application state, invoke at least two
sequential application-owned functions, receive each result through a
`previous_response_id` continuation, return final text, and leave the visible
application in the requested state. The browser observes only standard
`response.*` events and opaque Agent Connect identifiers.
Evidence: the 2026-08-28 run recorded a scrubbed report, HAR, and screenshot
under
`.agent-connect/evidence/open-responses-real-browser-2026-08-28-fresh-auth/`.
The report records four `/v1/responses` requests, the three-function sequence
`get_current_app_state`, `update_project_tasks`, `move_project_tasks`, final
Codex text, the final board state, and zero console or page errors.
Fail: the authorization redirect loses the task wire, requires a second
connection attempt, exposes a provider identifier or event, fails either
browser function, or produces no final browser-visible result.
Scope: this is a deliberate real-composition gate, not part of the routine test
suite because it consumes the operator's model allowance.

## Current status

Passed on 2026-08-28 from explicitly cleared browser storage with real Codex.
