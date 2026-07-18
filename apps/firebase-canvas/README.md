# Firebase Canvas demo

A static web application that lends a connected user-owned agent one
request-scoped tool: `set_page_message`. When the agent calls it, the page's
large canvas message changes immediately. The tool is defined by the loaded
page and is not installed into Codex or OmniGENT in advance. The same SDK path
has been proven with Codex through OmniGENT and with the deterministic public
judge runtime.

The Build Week surface is also a self-explaining product demo. Real task and
tool events drive a five-stage execution trace, while the architecture and
integration sections explain the application, connector, runtime, and security
boundaries. The public judge runtime is labeled as deterministic; the page does
not present that capability-limited environment as a live Codex session.

Product and visual direction are scoped to this application in
[`PRODUCT.md`](PRODUCT.md) and [`DESIGN.md`](DESIGN.md). Impeccable live-mode
configuration and design-system metadata live under `.impeccable/` in this
application, not at the monorepo root.

The app needs:

- the public runtime card printed when the connector identity is first created;
- a browser that can reach the connector's Tailscale Serve HTTPS URL.

The app verifies the card's connector key before sending its tool schema, then
redirects to the connector-owned authorization page. The enrollment passphrase
is entered only there, never into this application's JavaScript. The connector
enrolls the browser device, shows the exact origin and tool set, and returns a
PKCE-bound revocable grant. The page keeps that grant in `sessionStorage` for
the life of the tab.
The **Disconnect agent** action revokes that grant at the connector before
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

See `docs/plan/firebase-demo-setup.md` for the one-time Firebase/GitHub setup.
