# Gateway configuration reference (unstable ACP)

`agent-connect-gateway --help` lists `init`, `login`, `egress`, `serve` and
`release-info`. `serve --help` lists all flags. Release builds use the matching
session image by digest; `release-info` reports its compiled default.

`serve --config config.json` reads a JSON object with snake_case keys below.
Paths in the file resolve against its directory. Config must be an owned regular
file, mode 0600 or stricter, at most 1 MiB; symlinks and unknown fields are rejected.
The containing runtime should be private. Precedence is **CLI, environment,
config, defaults**. Each key supports `AGENT_CONNECT_<UPPER_SNAKE_KEY>`;
`AGENT_CONNECT_CONFIG` selects the file. CLI booleans accept `--boxed` or
`--boxed=false`. Never place real tokens in shell history or checked-in examples.

| JSON key / flag                             | Meaning / default                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `harness` / `--harness`                     | Required `codex` or `claude`                                                        |
| `listen` / `--listen`                       | `127.0.0.1:18940`                                                                   |
| `allow_origin` / `--allow-origin`           | Required exact HTTP(S) browser origin, no path/trailing slash                       |
| `token` / `--token`                         | Required operator-issued application bearer; prefer private config                  |
| `tools` / `--tools`                         | Required fixed snapshot JSON array of tool names and schemas                        |
| `harness_home` / `--harness-home`           | Dedicated whole-home read-write bind mount; required in production                  |
| `session_image` / `--session-image`         | Matching release digest; local builds use a versioned local tag                     |
| `egress_container` / `--egress-container`   | Required operator-selected proxy; setup uses `agent-connect-egress`                 |
| `boxed` / `--boxed`                         | Required true in production; set true by setup                                      |
| `permissions` / `--permissions`             | `sandboxed`, `app-tools-only` or `deny-all`; default `sandboxed`                    |
| `codex_mode` / `--codex-mode`               | Operator mode; boxed default `agent-full-access`, host fixture `workspace-write`    |
| `state_dir` / `--state-dir`                 | Private action journals; default `.agent-connect/gateway`                           |
| `max_sessions` / `--max-sessions`           | Positive capacity, default 32                                                       |
| `resume_grace_secs` / `--resume-grace-secs` | Detached session grace, default 600 seconds                                         |
| `resume_max_bytes` / `--resume-max-bytes`   | Unacknowledged output budget, default 8388608 bytes                                 |
| `mock_root` / `--mock-root`                 | Isolated deterministic fixture root; never a production host-mode switch            |
| `mock_url` / `--mock-url`                   | Fixture model URL, default `http://127.0.0.1:18931/v1`                              |
| `mock_container` / `--mock-container`       | Fixture model container; requires `mock_root`                                       |
| `durable_home` / `--durable-home`           | Legacy deterministic-fixture named-volume option; use dedicated home for production |

`sandboxed` means permission prompts are approved inside the container boundary;
it does not enable a separate nested Codex sandbox. `app-tools-only` rejects
native permission prompts while permitting approved application tools;
`deny-all` rejects all prompts. The gateway supplies cwd/mode/model policy;
the browser cannot override it. A fixed approved snapshot cannot expand on reconnect.

`RUST_LOG` controls diagnostics. `AGENT_CONNECT_GATEWAY_BIN` overrides the npm
launcher's executable for local testing. Image selection is also available to
init/login/egress as `AGENT_CONNECT_SESSION_IMAGE`; egress name as
`AGENT_CONNECT_EGRESS_CONTAINER`. No API-key environment is forwarded to boxes.

Process exit codes: 0 successful completion/help; 1 runtime/I/O/Docker/login
failure; 2 invalid arguments/configuration/snapshot or unsupported npm platform.
SIGINT/SIGTERM stop the server and its session hosts.

| WebSocket close  | Typed SDK code           | Action                                                          |
| ---------------- | ------------------------ | --------------------------------------------------------------- |
| 4401             | `invalid_app_grant`      | Obtain the correct application grant                            |
| 4403             | `authorization_denied`   | Match the approved origin                                       |
| 4404, 4410, 4413 | `session_expired`        | Load owned history if available; do not re-send uncertain turns |
| 4409             | `session_superseded`     | Another attachment owns this session                            |
| 4418             | `session_capacity`       | Wait for capacity or change the operator limit                  |
| 4500             | `agent_execution_failed` | Inspect isolated harness/container launch diagnostics           |

Turn recovery can return `task_interrupted`. Tools whose outcome is uncertain
must not be automatically repeated. See the SDK's
[ACP README](../../packages/web-sdk/README.md) for the complete API/error contract.
