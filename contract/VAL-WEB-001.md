# VAL-WEB-001: Browser-safe OmniGENT task stream

Surface: library.
Needs: an already-created, online OmniGENT session identifier.
Behavior: A web application can create a neutral `AgentSession`, start a task, and observe only `task.started`, `text.delta`, `tool.requested`, `tool.completed`, `task.completed`, `task.failed`, and `task.cancelled` events. The OmniGENT adapter uses browser-compatible fetch and streaming primitives with no Node runtime imports; OmniGENT/OpenAI envelopes, `action_required`, and `function_call_output` remain internal.
Evidence: Public built-package consumer fixture, exhaustive provider-to-public event mapping tests, TypeScript browser build, and adapter conformance tests against a fake provider plus the OmniGENT provider.
Fail: The message can race ahead of stream readiness, non-2xx responses are silently accepted, or provider wire types appear in the application-facing session, task, tool, event, or error types.
Scope: Session provisioning, runner launch, reconnect replay, and remote pairing are deferred.
