# Agent Connect for OpenClaw

This package installs Agent Connect into a stock OpenClaw gateway. OpenClaw
owns its HTTP routes and lifecycle; there is no second gateway process.

The package currently targets the integrity-pinned OpenClaw 2026.9.1
compatibility window. See the repository deployment guide for setup, supported
coexistence, recovery limits, and verification evidence.

The plugin follows the active host's configured token, password, or explicit
no-auth gateway mode through published OpenClaw resolution APIs. These native
host credentials are never application credentials; `/agent-connect` always
requires its own Origin-bound delegated grant.
