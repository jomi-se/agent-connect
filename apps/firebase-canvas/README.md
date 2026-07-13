# Firebase Canvas demo

A static web application that lends Codex one request-scoped tool:
`set_page_message`. When Codex calls it, the page's large canvas message changes
immediately. The tool is defined by the loaded page and is not installed into
Codex or OmniGENT in advance.

The app needs:

- the Tailscale Serve HTTPS URL for the Agent Connect gateway;
- an already provisioned OmniGENT session ID;
- the optional gateway bearer token, entered at runtime.

Build with:

```sh
npm run build --workspace @agent-connect/firebase-canvas
```

See `docs/plan/firebase-demo-setup.md` for the one-time Firebase/GitHub setup.
