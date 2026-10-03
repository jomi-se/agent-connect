# ACP gateway product parity

Status: active. Updated: 2026-10-03. ADR 0016 remains proposed.

Goal: an artifact-installed gateway provides guided setup, diagnosis, service
operation and owner management at least as well as the retained OpenClaw plugin.
No manual scripts or state-file inspection should be needed in the normal flow.
Plugin users start a new ACP runtime and pair applications again; personal
provider logins and plugin state are never imported. ACP/MCP-over-ACP remain unstable.
Per-application box isolation is explicitly deferred and outside this plan.

## Capability checklist

| Plugin capability               | ACP equivalent / required behavior                                                                     | Status                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Guided setup                    | `agent-connect setup`: private init, existing login helper, image/egress and service, resumable reruns | Pending                                      |
| Setup automation                | Planning `--json`; explicit `--apply --non-interactive`, no test login                                 | Pending                                      |
| Public entry point setup        | `--origin`, loopback defaults, reserved-domain proxy examples                                          | Pending                                      |
| Doctor                          | Human/JSON checks with stable codes and actionable fixes; no credential reads                          | Pending                                      |
| Service lifecycle               | User systemd and launchd install/uninstall/start/stop/status/logs                                      | Pending                                      |
| Health route                    | `/healthz`, readiness and serve preflight diagnostics                                                  | Pending                                      |
| Runtime problem banner          | Owner console shows health and repair guidance                                                         | Pending                                      |
| Live sessions                   | List active sessions and end one without revoking its app grant                                        | Pending                                      |
| Grant management                | Individual revoke exists; add revoke-all and forget-browser                                            | Partial                                      |
| Restricted profiles             | Owner-visible profiles, consent selection, immutable grant authority, honest per-harness limitations   | Pending                                      |
| Multiple entry points           | Configured origins shown in console and usable for pairing                                             | Pending                                      |
| Owner verification recovery     | Owner-run `reset-totp`, bounded recovery and audit behavior                                            | Pending                                      |
| Browser recovery                | SDK resumption exists; sample automatically recovers interrupted transport without replaying prompts   | Partial                                      |
| Product install guide           | Install → setup → connect → verify → doctor → upgrade → uninstall                                      | Pending                                      |
| Upgrade/migration               | Preserve ACP private state; explicit fresh-start plugin transition                                     | Pending                                      |
| Responsive/keyboard owner pages | Extend real-page UI gate to added controls and problem states                                          | Existing baseline; extension pending         |
| Artifact clean-room acceptance  | Setup automation, doctor, supported service operations, sessions/end and revoke-all                    | Existing pairing baseline; extension pending |
| Plugin release continuity       | Retain package, compatibility gates and documented owner-controlled release path                       | Reverify                                     |

## Earlier review findings

Each finding must be checked against current code, with regression evidence.
Previously fixed findings are not assumptions of compatibility.

| Finding | Required check / resolution                                                                                                           | Status   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 5       | Profiles must restrict Codex mode and accurately describe Claude behavior                                                             | Reverify |
| 6       | Assert mode/config denial, foreign MCP removal, unapproved/changed tools, undeclared connect, filesystem/terminal denial and profiles | Reverify |
| 8       | Egress network attachment requires `acp-egress` ownership label                                                                       | Reverify |
| 9       | Preserve outer metadata; MCP progress token comes from inner request metadata                                                         | Reverify |
| 10      | Action completion, bounded retention and blocking disk work off async runtime                                                         | Reverify |
| 11      | Bound/expire grant ownership and tool-title state                                                                                     | Reverify |
| 12      | Idle reconnect must retain a healthy stream and box                                                                                   | Reverify |
| 13      | One concurrent shutdown deadline for all hosts                                                                                        | Reverify |
| 14      | Plugin release path remains documented and owner-controlled                                                                           | Reverify |
| 16      | Typed Codex modes and stable SHA-256 durable-home names                                                                               | Reverify |
| 17      | Egress client caps, idle deadlines and bounded logs                                                                                   | Reverify |
| 18      | Published launcher supports Node >=24.15; repository baseline stays Node 24                                                           | Reverify |

The owner rejected finding 4: keep shared harness homes and default capacity 32;
do not add a refresh broker. Findings 1–3 retain terminal eviction 4415, frame
limit/1009 and the 30-second client connect deadline.

## Evidence and finish gate

- Narrow unit/contract gates after each implementation step; named-path commits.
- Deterministic real adapters and isolated HOME/XDG_STATE_HOME; no personal
  service changes, provider login or live subscription turns in tests.
- Before final commit: `npm run verify`, `cargo test --locked --workspace` and
  the artifact-only clean-room gate. Use quiet-run detached for long commands.
- Remove owned disposable fixtures/caches after checks and retain only sanitized
  evidence outside the repository. No publication, push or release workflow run.
- Owner-only gates remain live login checks, first release approval/run and
  ADR acceptance. They do not substitute for incomplete product work above.
