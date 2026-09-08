# Agent Connect for OpenClaw

Install `@open-agent-connect/openclaw-plugin` into a stock OpenClaw gateway.
OpenClaw
owns its HTTP routes and lifecycle; there is no second gateway process.

The package currently targets the integrity-pinned OpenClaw 2026.9.1
compatibility window. See the repository deployment guide for setup, supported
coexistence, recovery limits, and verification evidence.

Installation requires explicit host-capability consent:

```sh
openclaw plugins install @open-agent-connect/openclaw-plugin@0.1.0 --pin --accept-capabilities
```

The plugin keeps the public namespace `/agent-connect`. Preview configuration
with `openclaw agent-connect setup --origin https://your-gateway.example`, then
repeat with `--apply` only after reviewing the additions. Run
`openclaw agent-connect doctor` after restarting the gateway. This is a fresh
setup path; it does not migrate owner identity, grants, conversations, provider
credentials, or refresh tokens from an older deployment.

The plugin follows the active host's configured token, password, or explicit
no-auth gateway mode through published OpenClaw resolution APIs. These native
host credentials are never application credentials; `/agent-connect` always
requires its own Origin-bound delegated grant.

Conversation ownership and continuation mappings are bounded and process-local;
a restart ends them. Applications should use stable action IDs and make effects
idempotent rather than assuming exactly-once execution.
