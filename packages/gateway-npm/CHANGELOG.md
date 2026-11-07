# Changelog

## 0.0.6

- On Podman, a session's network no longer breaks the egress's name
  resolution. Session networks are created without DNS, and the box reaches
  the egress through host entries instead. Before, any open session made every
  outside lookup fail on Podman 5, so no prompt reached its provider.
- The box keeps Claude Code out of auto mode. claude-agent-acp 0.101.0 started
  sessions in auto mode, whose classifier answers permission requests itself,
  so the gateway's Claude profiles stopped applying. The box now ships managed
  settings that keep Claude Code's asking mode; they outrank the harness
  home's own settings.
- The gateway and the egress log one JSON object per line in OpenTelemetry's
  log data model, with `session.id` on everything a session causes and no
  session content: each ACP message gets one record with a 50-character
  preview. The box runs with no log driver, and on Podman the egress logs to
  the journal. See ADR 0021.
- The gateway logs how each session's box reaches its peers, and the egress
  logs a failed lookup as its own reason and each box's first connection.
- The macOS build runs on GitHub's macos-26 image; macos-14 was retired.

## 0.0.5

Nothing an owner installed is kept compatible before 1.0: after upgrading,
rerun `agent-connect setup`.

- The gateway drives Podman as well as Docker. Setup picks the engine once
  per runtime, prefers a rootless one when there is a choice, and records it
  as `container_engine` in the configuration. A rootful engine is refused for
  a new runtime, and on reruns, unless the owner accepts it. On a rootless
  engine, boxes run as the home's owner. See ADR 0020.
- `init` is removed: setup is the one way to create a runtime.
- The `egress` command is removed. The gateway owns its egress: it starts it
  before serving, stops it after any serve result, and replaces an owned
  egress built from another box. On Podman it keeps the rootless network up
  beside the egress.
- The durable-home volume option (`--durable-home`,
  `AGENT_CONNECT_DURABLE_HOME`, `durable_home`) is removed; a box gets the
  dedicated harness home or a tmpfs.
- `serve` keeps the locally built box on the latest harness releases: it
  rebuilds in the background, swaps the new box in once no session uses the
  old one, and discards boxes nothing uses. A rebuilt local box keeps grants.
- `doctor` warns when the gateway listening on the port is another version,
  and passes `listener_port` when it is this one.
- Owner sign-in: hardened HTTPS owner cookies and HSTS on hosted origins,
  pending app consent survives a failed sign-in, and safe sign-in failures
  and active pauses are shown.
- Messages and install docs name the container engine instead of Docker.

## 0.0.4

- The box takes the latest Claude Code, Codex and ACP adapters from npm when
  setup runs, instead of versions pinned per gateway release. A new harness
  release changes the box tag: `doctor` warns and `setup` rebuilds. Owners can
  pin any of them in `versions.json` in the owner box directory. Releases no
  longer record adapter pins.
- After an upgrade or owner-layer rebuild, setup names the box images it
  replaced and how to remove them. It never removes them itself.
- The box is built on Node 24.22.1, which carries the fixed Brotli decoder for
  CVE-2026-111497; the earlier Node 24.21.0 base and the previously pinned
  Claude Code 2.1.286 did not.
- The gateway uses rustls 0.23.46, rustls-webpki 0.103.16 and webpki-roots
  1.0.11, which fix TLS advisories including acceptance of distrusted
  intermediates.

## 0.0.3

- Keep the Codex code-mode host in the box. Codex runs MCP tools through code
  mode, so without it boxed Codex sessions had no application tools.
- First setup accepts directories writable only by the owner's own private
  group, the Ubuntu and Debian default for the systemd user unit directory.

## 0.0.2

- First-time setup and init ask for the owner passphrase at a terminal prompt
  only; `--owner-passphrase-file` is removed.
- Add `agent-connect reset-passphrase` for offline passphrase recovery.
- First release built with the mise-declared toolchain.
- Tests can select an isolated `agent-connect-box-test:` image, so test builds
  never replace an installed box tag.

## 0.0.1

- First release of the Agent Connect gateway and `agent-connect` CLI.
- Host owner passphrase sign-in, optional TOTP, exact-origin OAuth consent for
  fixed tools, rotating grants, session inspection and revocation.
- Run pinned ACP adapters and harness CLIs in Docker sessions with dedicated
  harness homes, restricted owned egress and cleanup before releasing capacity.
- Provide setup, owner-run login, doctor, systemd/launchd user service management,
  offline TOTP recovery, upgrade and explicit headless configuration.
- Package native executables for Apple Silicon macOS, Linux x64 and Linux ARM64
  through optional npm platform dependencies, with no runtime binary download.
- Keep ACP, MCP-over-ACP and transport resumption experimental. ADR 0016 was
  accepted on 2026-10-04; publication remains an owner gate.

See the [install guide](https://github.com/jomi-se/agent-connect/blob/main/docs/install/README.md).
