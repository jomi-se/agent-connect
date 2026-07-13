# ADR 0002: Evaluate OmniGENT as the conductor

Status: accepted for spike; final adoption gated

Date: 2026-07-13

## Context

OmniGENT already supplies normalized sessions, policy, harness lifecycle, generic downstream ACP support, a Codex-capable execution environment, HTTP/SSE APIs, and client-executed tools. Using it could avoid rebuilding a large orchestration backend.

OmniGENT currently acts as an ACP client toward downstream agents, not as a generic ACP server toward applications. Its generic ACP tool relay uses ordinary per-session stdio MCP. Its session stream is live-tail, and unresolved `action_required` client calls are not durably discoverable from the conversation snapshot.

## Decision

Build a time-boxed composition spike around a narrow OmniGENT fork:

- add an upstream ACP edge surface;
- accept one application-provided MCP-over-ACP server;
- translate prompts and updates through the Sessions API;
- drive Codex with the maintained generic ACP adapter path;
- prove one application tool call completes end to end.

Adopt OmniGENT as the conductor only if the exact callback path succeeds or requires a narrow, explainable patch.

## Go criteria

- A live Codex turn invokes a request-supplied application tool.
- The call becomes observable as `action_required` at the upstream adapter.
- Posting the returned tool output resumes the same turn to completion.
- The implementation does not require invasive duplication of OmniGENT's runner or harness lifecycle.

## No-go response

Keep the ACP application boundary and replace only the conductor implementation with a smaller gateway using Codex app-server `dynamicTools` for the first provider.
