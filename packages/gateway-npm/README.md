# Agent Connect gateway

`@open-agent-connect/gateway` installs the `agent-connect` CLI for a user-owned
agent gateway. It authorizes fixed application tools and runs harness sessions
in disposable Docker boxes. **0.0.1 is an early alpha release.**
ACP, MCP-over-ACP and transport resumption remain experimental.

After publication:

```sh
npm install --global @open-agent-connect/gateway@0.0.1
agent-connect setup
agent-connect login
agent-connect doctor
```

Start with the [install guide](https://github.com/jomi-se/agent-connect/blob/main/docs/install/README.md)
for prerequisites, local tarball installation, HTTPS setup, pairing, service
operation, upgrades and uninstall. Provider login is owner-run and uses a
separately revocable dedicated home. Read the
[credential boundary](https://github.com/jomi-se/agent-connect/blob/main/docs/plan/credentials.md)
before login.

The launcher selects a matching native binary through optional npm dependencies;
keep them enabled. It downloads no executable at launch and exposes no JavaScript
library API. Pinned ACP adapters and harness CLIs live in the matching session
image. `agentConnect.adapterVersions` records those pins. Published native
binaries embed an immutable image digest; `agent-connect release-info` reports it.

See [configuration](https://github.com/jomi-se/agent-connect/blob/main/docs/install/configuration.md),
[troubleshooting](https://github.com/jomi-se/agent-connect/blob/main/docs/install/troubleshooting.md)
and [release operations](https://github.com/jomi-se/agent-connect/blob/main/docs/install/release.md).
