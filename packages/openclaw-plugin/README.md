# Agent Connect for OpenClaw

Install `@open-agent-connect/openclaw-plugin` into a stock OpenClaw gateway.
OpenClaw
owns its HTTP routes and lifecycle; there is no second gateway process.

The package currently targets the integrity-pinned OpenClaw 2026.9.1
compatibility window. See the repository deployment guide for setup, supported
coexistence, recovery limits, and verification evidence.

Installation requires explicit host-capability consent:

```sh
openclaw plugins install @open-agent-connect/openclaw-plugin@0.0.1 --pin --accept-capabilities
```

The plugin keeps the public namespace `/agent-connect`. Run
`openclaw agent-connect setup` on a terminal for the guided flow: it asks only
for missing address/model choices, shows the restricted policy and proposed
changes, then applies after confirmation. Existing automation retains explicit
preview/apply behavior:

```sh
openclaw agent-connect setup --origin https://your-gateway.example --json
openclaw agent-connect setup --origin https://your-gateway.example --apply --non-interactive
```

Run `openclaw agent-connect doctor` after restarting the gateway. This is a
fresh setup path; it does not migrate owner identity, grants, conversations,
provider credentials, or refresh tokens from an older deployment.

The plugin follows the active host's configured token, password, or explicit
no-auth gateway mode through published OpenClaw resolution APIs. These native
host credentials are never application credentials; `/agent-connect` always
requires its own Origin-bound delegated grant.

Conversation ownership and continuation mappings are bounded and process-local;
a restart ends them. Applications should use stable action IDs and make effects
idempotent rather than assuming exactly-once execution.
