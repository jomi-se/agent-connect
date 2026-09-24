# Agent Connect

Let any web app use **your own AI agent** instead of shipping its own chatbot.

Today every app bolts on its own assistant, with its own model, its own subscription and no memory of you.
Agent Connect flips that: the app declares a few tools ("add items to this list", "edit this document"),
and your agent, running on a gateway you control, does the work using your existing AI subscription.

> **Status: early, experimental prototype (0.0.x).** Largely AI-assisted ("vibe-coded"). It works end to end
> in the demo, but it is not a hardened sandbox. Only connect it to a gateway you run yourself. Use at your own risk.

## How it works

```text
Web app  (@open-agent-connect/web + the app's own tools)
   │  OAuth consent, then Open Responses over HTTP/SSE
   ▼
Your gateway  (Agent Connect plugin inside OpenClaw)
   │  checks the grant: which app, which tools
   ▼
Your agent and model  (configured by you in OpenClaw)
```

- The app never sees your model credentials.
- On first connection you approve the exact app, scopes and tools. The grant is bound to them and can be revoked.
- The agent the app talks to is a dedicated, restricted one. Native OpenClaw tools are off by default.

## Try the demo

[`apps/firebase-canvas`](apps/firebase-canvas/) has three small example apps (a project board, a document editor,
a shopping list). It runs as a browser-only simulation, or against your own gateway.

## Run a gateway

Needs Node 24 (>=24.15, <25) and OpenClaw 2026.9.1 or newer.

```sh
openclaw plugins install @open-agent-connect/openclaw-plugin@0.0.7 --pin --accept-capabilities
openclaw agent-connect setup     # asks for your public HTTPS origin and a local port
# restart the gateway, then:
openclaw agent-connect doctor
```

Setup prints a one-time owner passphrase: save it in your password manager. Expose only the plugin's port over
HTTPS, never OpenClaw's own port. Details: [gateway guide](deploy/openclaw-gateway/README.md).

## Add it to a web app

```sh
npm install @open-agent-connect/web
```

```ts
const tools = [
  defineTool({
    name: "add_list_items",
    description: "Add several items to the current shopping list",
    inputSchema: {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
      required: ["items"],
    },
    execute: ({ items }) => shoppingList.addAll(items),
  }),
];
```

Then discover the user's gateway, run the OAuth flow, and stream responses. The
[integration guide](docs/guides/web-app-integration.md) walks through it.

## Security, in short

Treat every connected app as untrusted. The gateway enforces which app can call which tools, but the machine's
security is on you: keep the app agent's host tools disabled. More in [architecture](docs/architecture/) and the
[threat model](docs/research/2026-07-14-malicious-application-runtime-threat-model.md).

## Develop

```sh
npm install
npm run verify   # needs the pinned OpenClaw binary on PATH (see config/openclaw-test-compat.json)
```

See the [testing strategy](docs/architecture/testing-strategy.md) and the [docs index](docs/README.md).

## License

[MIT](LICENSE)
