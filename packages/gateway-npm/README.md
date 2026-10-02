# Agent Connect gateway

ACP prerelease **0.1.0-alpha.1**. ACP, MCP-over-ACP and transport resumption are
unstable. Release artifacts have not yet been published; these commands describe
the approved-release installation path.

Requires Node 24 (>=24.15, <25) and Docker. Supports Apple Silicon, Linux x64
and Linux ARM64. Windows is not yet supported.

```sh
npm install --global @open-agent-connect/gateway@0.1.0-alpha.1
agent-connect --help
agent-connect login
# Or, without a global installation:
npx @open-agent-connect/gateway@0.1.0-alpha.1 --help
```

Start with the [install and operator guide](https://github.com/jomi-se/agent-connect/blob/main/docs/install/README.md).
It covers the sample app, explicit tool consent, private config, Docker egress,
one-time Codex device login, recovery, upgrades and uninstalling. Claude Code
subscription use is unconfirmed against Anthropic terms; no API-key environment
variables are forwarded to session containers.

`agent-connect login` offers Codex and Claude Code, defaults to Codex, then
uses a dedicated home without requiring flags. Linux uses
`$HOME/.local/state/agent-connect/harnesses/<harness>`; macOS uses
`$HOME/Library/Application Support/agent-connect/harnesses/<harness>`.
`XDG_STATE_HOME` overrides the state root. New setup uses the same home.
Existing runtime homes work with `login --config <file>`. Explicit `--harness`
and `--harness-home` remain available. `agent-connect-gateway` is a compatibility
alias; both npm commands launch the same pinned platform executable.

The launcher selects one platform package through `optionalDependencies`.
Keep optional dependencies enabled. It performs no downloads during launch.
Adapters and harness CLIs live in the session image, so the npm installation does
not duplicate them on the host. Exact tested versions are recorded under
`agentConnect.adapterVersions` in package.json and checked against the image.
Each released binary defaults to that release's immutable image digest.

The release uses per-platform packages instead of cargo-dist's npm installer:
npm selects the host artifact and records its integrity without an install-time
binary download script. cargo-dist still produces archive and shell installers.
This choice does not claim a smaller total installed size than every alternative.

Exit codes: 0 success/help; 2 invalid arguments, configuration or unsupported platform;
1 runtime, Docker or provider-login failure. Signals shut down
session containers. `RUST_LOG` controls diagnostic verbosity. Bearers and harness
credentials must not be logged or committed.

For a local artifact test, install the launcher tarball and the matching
platform tarball together. `AGENT_CONNECT_GATEWAY_BIN` is a development-only
executable override; it is never an application-controlled setting.
