# Firebase Canvas demo

A static web application that shows how an independently owned application
works with a user-owned agent through Agent Connect. Its ten page-owned tools
span a shared live-state read plus project-board, document-review, and
product-research writes. Tool calls mutate the loaded page immediately; the
tools are defined by the application and are not installed into the user's
agent in advance.

The workbench has two deliberately separate entry paths:

- **Try the demo** runs a deterministic browser-only sequence against the real
  page-owned tool handlers. It needs no account, performs no OAuth transaction,
  and consumes no model allowance. It is product illustration, not protocol
  compatibility evidence.
- **Connect your agent** accepts a compatible Agent Connect HTTPS gateway
  address, discovers the stock OpenClaw plugin's OAuth metadata, and starts the
  published SDK's PKCE-bound authorization flow. Any live inference uses only
  the visitor's configured provider allowance.

Both paths append correlated application, gateway, agent, and browser-tool
events to the same visible activity trace.

Product and visual direction are scoped to this application in
[`PRODUCT.md`](PRODUCT.md) and [`DESIGN.md`](DESIGN.md). Impeccable live-mode
configuration and design-system metadata live under `.impeccable/` in this
application, not at the monorepo root.

The real path needs a browser-reachable HTTPS address for an already configured
Agent Connect stock OpenClaw plugin. Consent and sign-in happen on the user's
gateway, never in this application's JavaScript. The page keeps the resulting
delegated connection in `sessionStorage` for the life of the tab and refreshes
it through the SDK when required. **Disconnect & revoke access** revokes the
refresh authority at the gateway before clearing the browser copy.

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
