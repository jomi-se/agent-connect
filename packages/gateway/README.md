# Agent Connect gateway

The gateway is the narrow HTTPS-facing envelope for a browser application. It
binds to loopback, accepts only configured browser origins and Tailscale users,
and brokers only the application sessions and OmniGENT stream/event routes used
by the web SDK.

It is intentionally not a general OmniGENT reverse proxy.

## Run locally

```sh
export AGENT_CONNECT_ALLOWED_ORIGINS='https://PROJECT--agent-connect-HASH.web.app'
export AGENT_CONNECT_ALLOWED_TAILSCALE_USERS='you@example.com'
export AGENT_CONNECT_WORKSPACE='/path/the/codex-agent-may-use'
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

The browser base URL is then `https://MACHINE.TAILNET.ts.net:8443`. On startup,
the connector prints a code such as `AC-1234-5678-ABCD`. The user enters it into
the hosted application once. The code expires after ten minutes and rotates as
soon as it is used; the application receives a one-hour capability bound to its
Origin, app id, opaque session id, and exact tool snapshot.

The gateway uploads its narrow Codex ACP agent bundle, selects the one online
OmniGENT host, launches the runner, and replaces an unhealthy runner
automatically. Set `AGENT_CONNECT_OMNIGENT_HOST_ID` when several hosts are
online. Raw OmniGENT session ids never enter the browser configuration.

Pairing and session mappings currently live in memory. The optional legacy
`AGENT_CONNECT_ACCESS_TOKEN` only keeps the old raw-session proxy available for
the earlier spike; new applications should not use it. Durable device keys,
revocation, pending-action persistence, and a public relay remain future work.
