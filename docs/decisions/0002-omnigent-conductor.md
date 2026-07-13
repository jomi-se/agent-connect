# ADR 0002: Evaluate OmniGENT as the conductor

Status: accepted for the first provider

Date: 2026-07-13

## Context

OmniGENT already supplies normalized sessions, policy, harness lifecycle, generic downstream ACP support, a Codex-capable execution environment, HTTP/SSE APIs, and client-executed tools. Using it could avoid rebuilding a large orchestration backend.

OmniGENT currently acts as an ACP client toward downstream agents, not as a generic ACP server toward applications. Its generic ACP tool relay uses ordinary per-session stdio MCP. Its session stream is live-tail, and unresolved `action_required` client calls are not durably discoverable from the conversation snapshot.

## Decision

Run a time-boxed composition spike without an upstream ACP facade:

- supply one request-scoped client tool through the Sessions API;
- drive Codex with the maintained generic ACP adapter path;
- prove one application tool call completes end to end.

Adopt OmniGENT as the conductor only if the exact callback path succeeds or requires a narrow, explainable patch.

The spike passed on 2026-07-13 with OmniGENT 0.5.1 and published
`@agentclientprotocol/codex-acp` 1.1.2. The only compatibility code injects the
application schema into the top-level session message event because
`SessionsChat` 0.5.1 does not expose that wire field. No OmniGENT or Codex ACP
fork was required. The captured result is documented in
[the nonce experiment](../experiments/omnigent-codex-nonce.md).

Use OmniGENT as the first internal provider behind the gateway. Use its existing
HTTP/SSE surface for the hackathon; do not put an upstream ACP facade on the
critical path.

## Go criteria

- A live Codex turn invokes a request-supplied application tool.
- The call becomes observable as `action_required` at the upstream adapter.
- Posting the returned tool output resumes the same turn to completion.
- The implementation does not require invasive duplication of OmniGENT's runner or harness lifecycle.

## Deferred alternative

Keep a direct Codex app-server dynamic-tool spike as the control and fallback.
The gateway's public application API must not expose OmniGENT types.
