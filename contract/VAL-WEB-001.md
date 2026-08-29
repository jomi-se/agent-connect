# VAL-WEB-001: Browser-safe Open Responses task stream

Surface: library.
Needs: an authorized application session.
Behavior: A web application can create a neutral `AgentSession`, start a task, and observe only `task.started`, `text.delta`, `tool.requested`, `tool.completed`, `task.completed`, `task.failed`, and `task.cancelled` events. The `ResponsesProvider` uses browser-compatible fetch and SSE streaming primitives (`/v1/responses`) with no Node runtime imports; wire envelopes, function call parsing, and `function_call_output` continuations remain internal.
Evidence: Public built-package consumer fixture, exhaustive event mapping tests, TypeScript browser build, and provider conformance tests against the Open Responses gateway endpoint.
Fail: The message can race ahead of stream readiness, non-2xx responses are silently accepted, or wire types appear in the application-facing session, task, tool, event, or error types.
Scope: This contract covers the browser stream adapter. Session
provisioning, authorization, runner launch, and reconnect behavior are covered
by their gateway and higher-level SDK contracts. See [VAL-RESP-008](VAL-RESP-008.md).
