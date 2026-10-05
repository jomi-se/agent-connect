# Agent Connect gateway

`@open-agent-connect/gateway` installs the `agent-connect` CLI for a user-owned
agent gateway. It authorizes fixed application tools and runs harness sessions
in disposable Docker boxes. **This is an early alpha release.**
ACP, MCP-over-ACP and transport resumption remain experimental.

After publication:

```sh
npm install --global @open-agent-connect/gateway
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
library API. The launcher ships the complete box build recipe and locked adapter
inputs; platform packages ship the matching static Linux session-runner, including
Linux ARM64 for Apple Silicon. `agentConnect.adapterVersions` records the pins.
Setup explicitly builds `agent-connect-box:<version>` locally (roughly 1 GB),
reuses unchanged builds, and supports local owner tools through the XDG config
`agent-connect/box/` directory. There is no registry box or second publication
channel. `agent-connect release-info` reports the gateway version.

See [configuration](https://github.com/jomi-se/agent-connect/blob/main/docs/install/configuration.md),
[troubleshooting](https://github.com/jomi-se/agent-connect/blob/main/docs/install/troubleshooting.md)
and [release operations](https://github.com/jomi-se/agent-connect/blob/main/docs/install/release.md).
