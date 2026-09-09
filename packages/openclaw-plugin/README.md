# Agent Connect for OpenClaw

Install `@open-agent-connect/openclaw-plugin` into a stock OpenClaw gateway.
OpenClaw owns its lifecycle; the plugin owns a dedicated IPv4-loopback HTTP
listener for application traffic. There is no second gateway process.

CI and the reference deployment use integrity-pinned OpenClaw 2026.9.1 evidence,
while the plugin permits 2026.9.1 or newer without an upper bound. See the
repository deployment guide for setup, supported coexistence, recovery limits,
and verification evidence.

Installation requires explicit host-capability consent:

```sh
openclaw plugins install @open-agent-connect/openclaw-plugin@0.0.2 --pin --accept-capabilities
```

The plugin keeps the public namespace `/agent-connect`. Run
`openclaw agent-connect setup` on a terminal for the guided flow: it asks only
for missing address/listener/model choices, shows the restricted policy and
proposed changes, then applies after confirmation. Existing automation retains explicit
preview/apply behavior:

```sh
openclaw agent-connect setup --origin https://your-gateway.example --json
openclaw agent-connect setup --origin https://your-gateway.example --listen-port 18790 --apply --non-interactive
```

Run `openclaw agent-connect doctor` after restarting the gateway. This is a
fresh setup path; it does not migrate owner identity, grants, conversations,
provider credentials, or refresh tokens from an older deployment.

The plugin follows the active host's configured token, password, or explicit
no-auth gateway mode through published OpenClaw resolution APIs. These native
host credentials are never application credentials; `/agent-connect` always
requires its own Origin-bound delegated grant.

Forward public HTTPS to the configured application listener (default
`127.0.0.1:18790`), never the native OpenClaw port. The dedicated listener has no
native UI, terminal, RPC, `/v1/responses`, CONNECT or WebSocket surface.

Conversation ownership and continuation mappings are bounded and process-local;
a restart ends them. Applications should use stable action IDs and make effects
idempotent rather than assuming exactly-once execution.
