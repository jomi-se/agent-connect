# VAL-SANDBOX-001: VM-local OmniGENT sandbox preserves the dynamic tool loop

Surface: live downstream runtime.
Needs: OmniGENT 0.5.1, bubblewrap, dedicated Codex home, read-only application
workspace, outside-root host sentinel, pinned Codex ACP/Codex binaries, and one
request-scoped application tool.
Behavior: the outer runner hides the sentinel, rejects workspace writes, has
`NoNewPrivs=1` and seccomp filtering, gives only the dedicated Codex home write
access, and completes one request-scoped tool request/result/turn without
falling back unsandboxed.
Evidence: live process flags and mount table, guard result, host-sentinel probe,
Codex login, MCP startup, one `tool.requested`, correlated result, and completed
turn.
Fail: fallback to unsandboxed launch, visible host sentinel, writable workspace,
ambient normal Codex home, agent-readable long-lived login with unrestricted
egress, failed MCP startup, or no dynamic tool call.
Scope: host network is currently shared and `/tmp` supports the relay; this is
not hardware attestation or proof against a compromised gateway host.

## Current status

Blocked on 2026-07-14. Outer boundary evidence passes, but the Codex app-server
reports the OmniGENT MCP initialize connection closed, so the required dynamic
tool loop does not pass. The copied Codex login is also visible to the
network-capable full-access process, so credential isolation independently
fails. See the timestamped sandbox research document.
