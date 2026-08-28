# VAL-RESP-003: An unmodified Responses client completes the profile

Surface: api, protocol.
Needs: the `openai` JavaScript client at the version pinned in the repository
root `package.json`, and a grant on which the user approved non-browser
clients.
Behavior: a client configured only with `baseURL` and `apiKey` — the session
capability — creates a response, receives an application function call,
continues the chain with `previous_response_id` and one `function_call_output`,
receives a second call, continues again, and receives final text. The client's
own conveniences work against the returned resources, including `output_text`
and its SSE stream parser, and an out-of-profile field surfaces as a typed 400
carrying the pinned code and `param`.
Evidence: `packages/gateway/test/responses-conformance.test.ts` runs the real
`openai` package against a live gateway with a deterministic backend.
Fail: the client needs an Agent Connect-specific field, cannot parse a returned
resource or stream, or an out-of-profile field is silently accepted.
Scope: the one header beyond `baseURL` and `apiKey` is `Tailscale-User-Login`,
which stands in for the transport principal that Tailscale Serve injects in a
real deployment. It is a property of the network path, not of the protocol.
This contract uses a deterministic backend; a real Codex run is
[VAL-RESP-004](VAL-RESP-004.md).

## Current status

Passed on 2026-08-28 with `openai` 7.8.0.
