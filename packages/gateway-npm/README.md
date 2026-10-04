# Agent Connect gateway

An owner-controlled gateway that lets applications use your agent through
approved tools. ACP prerelease **0.0.1** remains an unpublished release
candidate; the commands below describe installation after the first approved
release. ACP, MCP-over-ACP and transport resumption are unstable.

Requires Node >=24.15, Docker and a browser. Supports Apple Silicon macOS, Linux
x64 and Linux ARM64. Windows is not yet supported. Repository and compatibility
checks use Node 24 LTS (>=24.15, <25); the launcher's broader engine range does
not claim every later Node major was tested.

```sh
npm install --global @open-agent-connect/gateway@0.0.1
agent-connect setup
agent-connect login
agent-connect doctor
```

For your own HTTPS entry point, use
`agent-connect setup --origin https://gateway.example`. Guided setup creates a
private owner runtime, checks the matching image and owned egress, and installs
and starts the platform user service. Provider login is owner-run and uses a dedicated
harness home. It does not import personal credentials. The owner passphrase and
optional TOTP protect browser sign-in; apps request exact-origin, fixed-tool
consent through the hosted owner page.

Start with the [install and operator guide](https://github.com/jomi-se/agent-connect/blob/main/docs/install/README.md)
for sample pairing, verification, upgrade, authenticator recovery and uninstall.
[Troubleshooting](https://github.com/jomi-se/agent-connect/blob/main/docs/install/troubleshooting.md)
covers stable doctor codes and recovery. `doctor --json` supports automation;
`setup --json` previews a plan without changes. Unattended application requires
explicit `--apply --non-interactive` with a protected owner-passphrase file and
never performs provider login.

`agent-connect service install|uninstall|start|stop|status|logs` manages user
systemd on Linux or launchd on macOS. `service --config <config> <operation>`
selects another runtime. The owner console shows health and configured entry
points, offers immutable restricted profiles at consent, ends individual live
sessions, revokes one or all grants, and can forget its browser session.
`/healthz` provides credential-free HTTP health. Service uninstall preserves
runtime, grants, journals and the dedicated shared home.

Keep the existing private runtime and harness home across upgrades. After stopping
active turns and installing the matching new version, `setup --upgrade` updates
the release image and owned service/egress while preserving owner authentication,
journals and dedicated login homes. Changed policy/image requires new app
consent. ACP setup creates a fresh runtime with dedicated login and application pairing.

The shared home intentionally contains credentials, configuration and transcripts
from all applications; consented tools can disclose its data. Read the
[accepted credential risks](https://github.com/jomi-se/agent-connect/blob/main/docs/plan/credentials.md)
before login. Claude Code subscription use remains unconfirmed against
Anthropic's terms. API-key environment variables are never forwarded into boxes.
The explicit `--headless-static-bearer` path is separate from normal pairing.

The launcher selects its native binary through per-platform optional npm
dependencies. Keep them enabled. It performs no executable downloads at launch;
pinned adapters and harness CLIs live in the matching session image. Exact pins
are recorded in `agentConnect.adapterVersions`, and released binaries default to
an immutable image digest. `agent-connect-gateway` remains a compatibility alias.

For local artifact installation, install the launcher tarball and matching
platform tarball together. `AGENT_CONNECT_GATEWAY_BIN` is a development-only
binary override. `release-info` reports version and image. Exit codes are 0 for
success/help, 2 for invalid arguments/configuration or unsupported npm platforms,
and 1 for runtime, Docker or provider-login failure. `RUST_LOG` controls diagnostic
verbosity; keep secrets out of logs and issues.
