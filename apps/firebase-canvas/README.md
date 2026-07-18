# Firebase Canvas demo

A static web application that lends Codex one request-scoped tool:
`set_page_message`. When Codex calls it, the page's large canvas message changes
immediately. The tool is defined by the loaded page and is not installed into
Codex or OmniGENT in advance.

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

See `docs/plan/firebase-demo-setup.md` for the one-time Firebase/GitHub setup.
