# Agent Connect gateway

The gateway is the narrow HTTPS-facing envelope for a browser application. It
binds to loopback, accepts only configured browser origins and Tailscale users,
and proxies only the OmniGENT session stream and event routes used by the web
SDK.

It is intentionally not a general OmniGENT reverse proxy.

## Run locally

```sh
export AGENT_CONNECT_ALLOWED_ORIGINS='https://PROJECT--agent-connect-HASH.web.app'
export AGENT_CONNECT_ALLOWED_TAILSCALE_USERS='you@example.com'
export AGENT_CONNECT_ACCESS_TOKEN='a-long-random-runtime-secret' # optional
npm run build --workspace @agent-connect/gateway
npm run start --workspace @agent-connect/gateway
```

Defaults:

- gateway: `http://127.0.0.1:8787`
- OmniGENT: `http://127.0.0.1:6767`

Keep the gateway on loopback. Tailscale Serve terminates HTTPS and adds the
authenticated Tailscale identity headers:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8787
```

The browser base URL is then
`https://MACHINE.TAILNET.ts.net:8443`. If an access token is configured, pass it
to `connectOmnigent` as an `Authorization: Bearer ...` header. Do not compile the
token into a Firebase bundle; enter it at runtime and keep it in memory or
`sessionStorage` for the personal-use spike.

The current gateway assumes a separately provisioned OmniGENT session. Session
creation, runner ownership, expiring pairing capabilities, and durable pending
actions remain later milestones.
