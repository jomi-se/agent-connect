# Agent Connect gateway

ACP prerelease **0.1.0-alpha.1**. ACP, MCP-over-ACP and transport resumption are
unstable. Release artifacts have not yet been published; these commands describe
the approved-release installation path.

Requires Node >=24.15 and Docker. The launcher only selects and spawns the
pinned native executable, so its npm engine range permits later Node majors.
Repository development and provider compatibility checks continue to use
Node 24 LTS; this range does not claim every later major has been tested. Supports Apple Silicon, Linux x64
and Linux ARM64. Windows is not yet supported.

```sh
npm install --global @open-agent-connect/gateway@0.1.0-alpha.1
agent-connect --help
agent-connect login
# Or, without a global installation:
npx @open-agent-connect/gateway@0.1.0-alpha.1 --help
```

Start with the [install and operator guide](https://github.com/jomi-se/agent-connect/blob/main/docs/install/README.md).
It covers the sample app, hosted owner sign-in and tool consent, private config, Docker egress,
one-time Codex device login, recovery, upgrades and uninstalling. Claude Code
subscription use is unconfirmed against Anthropic terms; no API-key environment
variables are forwarded to session containers.

Normal setup uses `agent-connect init --directory <private-runtime> --harness codex`
(or adds `--public-url https://gateway.example` for remote use). It prompts for
a hidden owner passphrase and confirmation. Unattended setup uses a private
`--owner-passphrase-file`; keep owner state outside the dedicated harness home.
Start egress, then `agent-connect serve --config <private-runtime>/config.json`.
Applications request their own exact origin and fixed tools through hosted OAuth
consent; no normal `grant.json` or `tools.json` handoff is required.

The owner page at `/agent-connect/owner` provides optional TOTP enrollment and
individual grant revocation without restarting. Once enrolled, TOTP is required
at sign-in and approval. Remote owner pages, OAuth routes, metadata and `/acp`
must share the configured HTTPS origin through the reverse proxy. Owner sign-in
is separate from provider login. `--headless-static-bearer` explicitly retains
the manual origin/tool/token path for headless integrations and is off by default.

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
