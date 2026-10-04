# ACP gateway product parity

Status: completed local qualification. Updated: 2026-10-03.
ADR 0016 was accepted on 2026-10-04. This archived checklist records the tested candidate;
current install instructions and owner release gates live in
[the install guide](../../install/README.md) and
[current work](../../plan/current-work.md).

Goal: an artifact-installed gateway provides guided setup, diagnosis, service
operation and owner management at least as well as the retained OpenClaw plugin.
No manual scripts or state-file inspection should be needed in the normal flow.
Plugin users start a new ACP runtime and pair applications again; personal
provider logins and plugin state are never imported. ACP/MCP-over-ACP remain unstable.
Per-application box isolation is explicitly deferred and outside this plan.

## Capability checklist

| Plugin capability               | ACP equivalent                                                                    | Outcome and evidence                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guided setup                    | Private init, owner-run login helper, image/egress/service, resumable reruns      | Done; setup/config tests and artifact acceptance. Interactive login is owner-run.                                                                                |
| Setup automation                | Planning `--json`; explicit `--apply --non-interactive`                           | Done; artifact tests prove planning/persistence without invoking login.                                                                                          |
| Public entry point setup        | `--origin`, loopback defaults, persistent `--entry-point`, proxy examples         | Done; config and exact-origin/alias authorization tests.                                                                                                         |
| Doctor                          | Human/JSON stable codes, actionable fixes, credential metadata only               | Done; diagnostic tests and artifact acceptance.                                                                                                                  |
| Service lifecycle               | User systemd and launchd install/uninstall/start/stop/status/logs                 | Done; isolated manager contracts, offline definition lifecycle and systemd unit validation. Native macOS execution remains first-release platform qualification. |
| Health route                    | `/healthz`, readiness and serve preflight diagnostics                             | Done; runtime and artifact tests.                                                                                                                                |
| Runtime problem banner          | Owner health and repair guidance                                                  | Done; real-page test includes an owned egress outage.                                                                                                            |
| Live sessions                   | List and end a session without revoking its grant                                 | Done; browser tests verify physical host cleanup before capacity release.                                                                                        |
| Grant management                | Individual revoke, revoke-all and forget-browser                                  | Done; authorization/UI tests and artifact revoke-all acceptance.                                                                                                 |
| Restricted profiles             | Owner choices, immutable grant authority, honest harness limits                   | Done with qualification below; unsupported combinations rejected, policy and consent tests pass.                                                                 |
| Multiple entry points           | Origin-bound owner, issuer, token and socket authority                            | Done; alias and cross-origin rejection tests.                                                                                                                    |
| Owner verification recovery     | Offline owner-run `reset-totp`, exclusive lock, bounded audit                     | Done; recovery tests. Recovery codes and mobile approval are deferred; the offline command supplies recovery.                                                    |
| Browser recovery                | Retain healthy transport; recover interruption without prompt/effect replay       | Done; SDK and artifact browser tests, including idle and pending-tool back/forward cache restoration.                                                            |
| Product install guide           | Install → setup → connect → verify → doctor → upgrade → uninstall                 | Done; product docs, reserved-domain proxy examples and diagnostic-code troubleshooting.                                                                          |
| Upgrade/migration               | Explicit image/service upgrade preserving state; fresh ACP setup for plugin users | Done; atomic upgrade and owned-service restart tests. Plugin state is not imported.                                                                              |
| Responsive/keyboard owner pages | Management controls and error/problem states                                      | Done; twenty states at widths 1440, 390 and 320, with keyboard/touch checks.                                                                                     |
| Artifact clean-room acceptance  | Setup, doctor, supported services, sessions/end and revoke-all                    | Done; 26 checks from release tarballs in a fresh container without a checkout.                                                                                   |
| Plugin release continuity       | Retain package, compatibility gates and owner-controlled release path             | Done; real pinned plugin compatibility passes; release path documented, publication remains owner-only.                                                          |

## Earlier review findings

Each finding was rechecked against current code and passing regression evidence.
Previously landed fixes were verified rather than assumed.

| Finding | Required check / resolution                                                                                                           | Status                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 5       | Profiles must restrict Codex mode and accurately describe Claude behavior                                                             | Fixed and verified in current regression tests |
| 6       | Assert mode/config denial, foreign MCP removal, unapproved/changed tools, undeclared connect, filesystem/terminal denial and profiles | Verified in current code and regression tests  |
| 8       | Egress network attachment requires `acp-egress` ownership label                                                                       | Verified in current code and regression tests  |
| 9       | Preserve outer metadata; MCP progress token comes from inner request metadata                                                         | Fixed and verified in current regression tests |
| 10      | Action completion, bounded retention and blocking disk work off async runtime                                                         | Verified in current code and regression tests  |
| 11      | Bound/expire grant ownership and tool-title state                                                                                     | Verified in current code and regression tests  |
| 12      | Idle reconnect must retain a healthy stream and box                                                                                   | Fixed and verified in current regression tests |
| 13      | One concurrent shutdown deadline for all hosts                                                                                        | Verified in current code and regression tests  |
| 14      | Plugin release path remains documented and owner-controlled                                                                           | Verified in current code and regression tests  |
| 16      | Typed Codex modes and stable SHA-256 durable-home names                                                                               | Verified in current code and regression tests  |
| 17      | Egress client caps, idle deadlines and bounded logs                                                                                   | Verified in current code and regression tests  |
| 18      | Published launcher supports Node >=24.15; repository baseline stays Node 24                                                           | Verified in current code and regression tests  |

The owner rejected finding 4: keep shared harness homes and default capacity 32;
do not add a refresh broker. Findings 1–3 retain terminal eviction 4415, frame
limit/1009 and the 30-second client connect deadline.

Finding 5 qualification: Codex read-only launch mode and approved-tool permission
attribution are regression-tested. The real boxed adapter completes approved app
tools and prevents the native write. On this Docker host, however, the nested
sandbox refuses namespace creation before execution. This is fail-closed native
effect prevention, not independent evidence of filesystem-policy enforcement.
Consent/console copy and troubleshooting explain the limitation; no container
privilege was widened. Native filesystem qualification on a supported host remains
part of the first-release platform checks.

The independent parity review additionally found and fixed executable-only
upgrades leaving an old service running, equivalent relative harness-home paths
breaking reruns, and grants crossing their selected gateway entry point at the
WebSocket boundary. Regression tests cover all three. Installed services now
preserve a bounded, validated Docker search path with manager-specific escaping.
Review also caught a browser-fixture cleanup failure skipping gateway shutdown;
all owned cleanup tasks are now attempted before reporting failures. The sample
now disables idle controls immediately after terminal owner action and guards
against stale recovery callbacks. Every legacy OpenClaw fixture child receives
explicit disposable HOME/XDG state. Owner UI tests poll fresh server snapshots
through completed cleanup and confirm that the controlled adapter process exits.

## Completed evidence and qualification limits

- `npm run verify` passed on the frozen implementation, including format,
  typecheck, package tests/builds, pinned OpenClaw compatibility, both real ACP
  adapters in host/boxed scenarios, teardown, owner UI and artifact clean-room.
- `cargo test --locked --workspace` passed authorization, configuration,
  operations, policy, registry, resume and sandbox regression gates.
- SDK Vitest passed 220 tests; plugin tests passed 84. Recovery tests preserve
  healthy identity without `session/load`, `bye`, prompt replay or effect replay.
  MCP progress tests cover inner request metadata and keepalive handling.
- Owner UI passed twenty states at all three widths (60 page states), including
  sessions/end, revoke-all, profiles, entry points, TOTP and egress repair.
- Artifact clean-room passed all 26 checks using packed SDK/CLI artifacts and
  deterministic real Codex. It removed all six owned session hosts, with no
  leftovers. Setup/doctor and offline service install/uninstall are exercised;
  absent native managers yield actionable errors rather than simulated success.
- The current native ARM64 Linux-musl binary and matching npm tarballs built
  locally. This does not qualify the complete native release matrix. Native
  macOS service execution and Codex filesystem-policy qualification on a host
  supporting the nested sandbox remain first-release platform checks.
- Tests isolate HOME/XDG state; no personal service, harness login or live
  subscription turn was used. ACP/MCP-over-ACP remain unstable.
- Owned disposable fixtures and build caches are cleaned after qualification;
  only sanitized evidence and local release candidates are retained outside Git.
  No push, publication or release workflow run occurred.

Per-application box isolation remains explicitly deferred. Windows remains
unsupported. Mobile second-factor approval and recovery codes are future work;
owner TOTP and offline recovery are implemented. These are explicit scope
boundaries, not unfinished local parity checks.

Owner-run live credential checks and first release/account/platform validation
remain before publication. ADR 0016 was accepted on 2026-10-04. See current work for the
current release gates rather than using this archived execution record.
