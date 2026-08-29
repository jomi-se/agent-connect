# Agent Connect gateway

The gateway is the narrow HTTPS-facing envelope for browser applications. It
binds to loopback, authenticates the configured Tailscale user, and exposes
OAuth authorization, application session provisioning (`POST /v1/app-sessions`),
and the standard Open Responses endpoint (`POST /v1/responses`) along with
namespaced Agent Connect response control routes. The private reference profile
can enroll previously unknown HTTPS Origins through gateway-owned consent; a
static Origin allowlist remains available as an operator policy.

It is intentionally not a general Omnigent reverse proxy and never exposes raw
provider session or stream routes to the client.

## Run locally

For the supported Omnigent/Codex supervisor, dedicated Codex home, current
Tailscale Serve setup, and security boundary, use the
[real gateway guide](../../deploy/real-gateway/README.md). The commands
below show the lower-level generic gateway profile.

```sh
export AGENT_CONNECT_ALLOWED_ORIGINS='https://PROJECT--agent-connect-HASH.web.app'
export AGENT_CONNECT_DYNAMIC_APP_ENROLLMENT='1'
export AGENT_CONNECT_ALLOWED_TAILSCALE_USERS='you@example.com'
export AGENT_CONNECT_WORKSPACE='/path/the/codex-agent-may-use'
export AGENT_CONNECT_STATE_PATH='/owner-only/path/agent-connect.json'
export AGENT_CONNECT_PUBLIC_ENDPOINT='https://MACHINE.TAILNET.ts.net:8443'
export AGENT_CONNECT_TRANSPORT_PROFILE='tailscale-serve'
npm run build --workspace @agent-connect/gateway
node packages/gateway/dist/initialize-main.js
npm run start --workspace @agent-connect/gateway
```

Defaults:

- gateway: `http://127.0.0.1:8787`
- Omnigent: `http://127.0.0.1:6767`

Keep the gateway on loopback. Tailscale Serve terminates HTTPS and adds the
authenticated Tailscale identity headers:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8787
```

The browser base URL is then `https://MACHINE.TAILNET.ts.net:8443`. The one-shot
initializer prints a runtime card and generated enrollment secret as clearly
separated outputs. Save the secret in a password manager. It persists only a
salted verifier and refuses to overwrite existing state; normal gateway startup
refuses uninitialized state. Import only the public card into the app; enter the
passphrase only on the gateway-owned consent page.
The app verifies a signed gateway challenge before sending its tools and uses
S256 PKCE to obtain a revocable origin/app/tool-bound grant.

With `AGENT_CONNECT_DYNAMIC_APP_ENROLLMENT=1`, an unknown HTTPS Origin may
reach the signed-challenge and authorization endpoints. This is not ambient
agent access: Tailscale must authenticate the configured operator, the
gateway-owned page requires explicit consent, redirects must remain on the
requesting Origin, and all later requests require the exact bound grant. This
mode is accepted only with `AGENT_CONNECT_TRANSPORT_PROFILE=tailscale-serve`.
Applications may revoke their own grant through bearer-authenticated
`POST /oauth/revoke`; the response deliberately does not reveal whether the
submitted token existed. Gateway-owned grant listing and administrative
revocation remain on `/v1/grants`.

The gateway uploads its narrow Codex ACP agent bundle, selects the one online
Omnigent host, launches the runner, and replaces an unhealthy runner
automatically. Set `AGENT_CONNECT_OMNIGENT_HOST_ID` when several hosts are
online. Raw Omnigent session ids never enter the browser configuration.

Gateway keys, enrolled-device token hashes, grant token hashes, revocation,
and the capability secret are durable. Pending authorization requests, codes,
provider-session mappings, and rate-limit counters are still memory-only. The
gateway accepts application-session creation only through an approved grant,
and it never exposes raw Omnigent session routes.

An experimental VM-local sandbox can be selected with
`AGENT_CONNECT_OMNIGENT_SANDBOX=linux_bwrap` plus the required Codex-home,
host-sentinel, and read-path variables. Read the
[sandbox spike](../../docs/research/2026-07-14-omnigent-vm-sandbox-spike.md)
before using it: the outer boundary passes, but the sandboxed dynamic-tool loop
is currently blocked at MCP startup and the full-access agent can read the
copied Codex login while network is enabled. It is experimental evidence, not
a safe malicious-app profile.
