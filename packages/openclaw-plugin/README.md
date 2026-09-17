# Agent Connect for OpenClaw

Install `@open-agent-connect/openclaw-plugin`, the Agent Connect plugin for
OpenClaw, into the user's OpenClaw gateway.
OpenClaw owns its lifecycle; the plugin owns one or more dedicated
IPv4-loopback HTTP listeners for application traffic. There is no second
gateway process.

CI and the reference deployment use integrity-pinned OpenClaw 2026.9.1 evidence,
while the plugin permits 2026.9.1 or newer without an upper bound. See the
repository deployment guide for setup, supported coexistence, recovery limits,
and verification evidence.

Installation requires explicit host-capability consent:

```sh
openclaw plugins install @open-agent-connect/openclaw-plugin@0.0.6 --pin --accept-capabilities
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

Deployments that expose the same restricted agent through independent HTTPS
origins can configure multiple entry points directly in the plugin config:

```json
{
  "entryPoints": [
    {
      "id": "default",
      "publicOrigin": "https://private-gateway.example",
      "listenPort": 18790
    },
    {
      "id": "public",
      "publicOrigin": "https://public-gateway.example",
      "listenPort": 18791
    }
  ],
  "agentId": "agent-connect-app"
}
```

Every entry point has its own issuer, resource, grants, authorization codes,
refresh tokens, listener and process-local conversations. A credential issued
through one entry point is rejected by the others. The agent configuration and
native OpenClaw upstream are shared. The IDs, origins and ports must each be
unique. Use ID `default` for an existing single-entry deployment when retaining
its delegated-grant state during migration. The `setup --origin` and
`--listen-port` flags intentionally configure only the simple single-entry
form; edit reviewed host configuration to declare multiple entry points.

Run `openclaw agent-connect doctor` after restarting the gateway. This is a
fresh setup path; it does not migrate owner identity, grants, conversations,
provider credentials, or refresh tokens from a retired standalone deployment.
An in-place upgrade from the immediately preceding Agent Connect plugin auth state
preserves its enrollment verifier and active owner-browser sessions while
discarding retired device keys and device grants.

The plugin follows the active host's configured token, password, or explicit
no-auth gateway mode through published OpenClaw resolution APIs. These native
host credentials are never application credentials; `/agent-connect` always
requires its own Origin-bound delegated grant.

Forward each public HTTPS origin only to its configured application listener
(single-entry default `127.0.0.1:18790`), never the native OpenClaw port. These
listeners have no native UI, terminal, RPC, `/v1/responses`, CONNECT or
WebSocket surface. Every listener response disables caching and carries a
robots no-index directive; edge caching and indexing controls remain defense in
depth.

Forwarding and provider identity headers are ignored, never trusted for
authority; configured origins and Origin-bound grants remain decisive. A shared
no-queue admission controller bounds HTTP and inference concurrency across all
entry points, applies a per-grant request rate, and releases capacity on every
terminal path. Generous byte limits support document transformation while
bounding memory; callers may request up to 65,536 output tokens. See
[Agent Connect plugin for OpenClaw architecture](../../docs/architecture/agent-connect-openclaw-plugin.md)
for the exact limits.

Conversation ownership and continuation mappings are bounded and process-local;
a restart ends them. Applications should use stable action IDs and make effects
idempotent rather than assuming exactly-once execution.
