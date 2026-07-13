# VAL-WEB-003: Explicit cancellation and failure behavior

Surface: library.
Needs: VAL-WEB-001.
Behavior: The client exposes explicit cancellation, reports failures through `AgentConnectError` codes (`http_error`, `protocol_error`, `unknown_tool`, `invalid_tool_arguments`, `tool_execution_failed`), and terminates a task stream on completed, failed, cancelled, or incomplete provider terminal events. Benign SSE comments/unknown events may be ignored; malformed JSON for a recognized event fails with `protocol_error`.
Evidence: Unit tests for interrupt request shape, HTTP error body handling, recognized malformed SSE rejection, unknown-event skipping, exhaustive terminal mapping, and abort cleanup.
Fail: A failed request appears successful, cancellation relies only on closing the browser connection, provider-specific error types escape, or a terminal event leaves the stream hanging.
Scope: Automatic reconnect and recovery are deferred.
