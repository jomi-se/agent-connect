# Multi-turn task continuation

Status: promoted to active design work on 2026-08-30.

The original note incorrectly said every `AgentSession.streamTask()` creates a
fresh underlying conversation. Investigation against Omnigent 0.5.1 showed the
opposite: an Omnigent session is a durable ACP session, and each prompt merely
opens a fresh event subscription for the next turn.

The missing behavior is therefore not provider-side memory. It is an honest,
application-visible way to say that a new task continues the latest completed
task, with enough gateway validation to prevent stale branches and silent
continuation after the provider session has been replaced.

The bounded design, validation contracts, and implementation sequence now live
in `docs/plan/multi-turn-task-continuation.md`.

This work remains separate from recovery of a task parked on an unresolved
application function call. Pending-call recovery needs stable action IDs and
application-owned deduplication before the SDK may redeliver side effects.
