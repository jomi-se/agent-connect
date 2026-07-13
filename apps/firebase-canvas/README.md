# Firebase Canvas demo

A static web application that lends Codex one request-scoped tool:
`set_page_message`. When Codex calls it, the page's large canvas message changes
immediately. The tool is defined by the loaded page and is not installed into
Codex or OmniGENT in advance.

The app needs:

- the Tailscale Serve HTTPS URL for the Agent Connect gateway;
- the one-time pairing code printed by the gateway at startup.

The gateway creates and owns the OmniGENT/Codex session. After pairing, the page
keeps its scoped capability in `sessionStorage` for the life of the tab.

Build with:

```sh
npm run build --workspace @agent-connect/firebase-canvas
```

See `docs/plan/firebase-demo-setup.md` for the one-time Firebase/GitHub setup.
