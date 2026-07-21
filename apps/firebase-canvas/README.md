# Firebase Canvas demo

A static web application that lends a connected user-owned agent a ten-tool
snapshot spanning a shared live-state read plus project-board, document-review,
and product-research writes. When
the runtime calls those tools, the loaded page mutates immediately. The tools
are defined by the page and are not installed into Codex or Omnigent in
advance. The same SDK path has been proven with Codex through Omnigent and with
the deterministic public judge runtime.

The Build Week surface is also a self-explaining product demo. Real connection,
task, tool-call, result, and completion events append to a live activity feed;
there is no predefined execution path. The architecture and integration
sections explain the application, gateway, runtime, and security boundaries.
The public judge runtime is labeled as deterministic; the page does not present
that capability-limited environment as a live Codex session.

Product and visual direction are scoped to this application in
[`PRODUCT.md`](PRODUCT.md) and [`DESIGN.md`](DESIGN.md). Impeccable live-mode
configuration and design-system metadata live under `.impeccable/` in this
application, not at the monorepo root.

The app needs:

- the public runtime card printed when the gateway identity is first created;
- a browser that can reach the gateway's Tailscale Serve HTTPS URL.

The app verifies the card's gateway key before sending its tool schema, then
redirects to the gateway-owned authorization page. The enrollment passphrase
is entered only there, never into this application's JavaScript. The gateway
enrolls the browser device, shows the exact origin and tool set, and returns a
PKCE-bound revocable grant. The page keeps that grant in `sessionStorage` for
the life of the tab.
The **Disconnect agent** action revokes that grant at the gateway before
clearing the browser copy. If access was already revoked elsewhere, Canvas
discards the rejected local credential and lets the next Run begin a fresh
authorization flow.

Build with:

```sh
npm run build --workspace @agent-connect/firebase-canvas
```

Run the browser behavior suite with:

```sh
npm run test:e2e --workspace @agent-connect/firebase-canvas
```

See the
[Firebase deployment guide](../../docs/guides/firebase-demo-deployment.md) for
the one-time Firebase/GitHub setup.
