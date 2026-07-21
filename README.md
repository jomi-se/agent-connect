# Agent Connect

Bring your own coding agent to any web app.

Build AI features by leveraging users' coding agents included with their
subscriptions. This is currently focused on Codex specifically, but the goal is
to support any agent that has an ACP interface.

## Built with Codex and GPT-5.6

Agent Connect was designed and implemented through Codex using GPT-5.6 Sol Medium for the most part. Codex
researched Omnigent and ACP, shaped the provider-neutral boundary, implemented
the SDK, gateway, authorization flow, test layers, public demo, and real
browser-to-Codex composition, and debugged the deployed mobile flow.

The primary `/feedback` build thread is
`019f5c47-a462-73d0-a329-39013786bae4`.

## Try the public demo

Open [agent-connect-demo.web.app](https://agent-connect-demo.web.app/), paste
the runtime card supplied in the judge instructions, and connect with the
private enrollment passphrase on the gateway authorization page.

The demo includes three example apps: a project-board app with bulk editing,
in-place document review in a document editor, and product research in a
shopping app. It uses the Agent Connect browser SDK and gateway. Internally, it
uses [Omnigent](https://omnigent.ai/) as an agent orchestrator, Codex as the
agent, and [Tailscale](https://tailscale.com/) as the network path between the
demo web app and a live Agent Connect gateway.

The demo's runtime card targets an Agent Connect gateway in front of a
fixture-based agent behind an ACP interface, so anyone can test it without
consuming a model account. Codex with GPT-5.6 was used to author these
scenarios.

The separate reference profile below runs the same path with a real Codex
instance and the user's own account. The same demo web app accepts either
profile's runtime card: use the public judge demo on port `10000` for the
deterministic evaluation path, or a user-owned gateway you set up for live
model reasoning.

## Run the real Codex reference profile

The [real gateway guide](deploy/real-gateway/README.md) starts the usable MVP on
a Linux machine. It requires a [Tailscale account and tailnet](https://tailscale.com/docs/install),
with Tailscale installed and authenticated on both the gateway host and the
browser device.

```sh
curl -fsSL https://omnigent.ai/install.sh | sh -s -- --version 0.5.1
git clone https://github.com/jomi-se/agent-connect.git
cd agent-connect
npm install
npm run build

cp deploy/real-gateway/.env.example deploy/real-gateway/.env
# Configure Tailscale endpoint, user, dedicated CODEX_HOME, and workspace.
deploy/real-gateway/run.sh
```

The supervisor runs a loopback Agent Connect gateway, Omnigent server and host,
a narrow compatibility wrapper around the pinned `codex-acp` adapter, and a
real Codex process. Tailscale Serve publishes only the gateway over
authenticated HTTPS.

On a first connection, the gateway shows the exact
Origin, callback, scopes, and tools before approval. The resulting grant is
bound to that Origin, app id, redirect URI, scope set, and tool
snapshot. The frozen anonymous judge profile deliberately keeps its fixed
application allowlist.

## Add Agent Connect to a web app

`@agent-connect/web` is a browser-safe TypeScript package. It is currently
distributed from source until it is more stable for normal npm package. The
[web application integration guide](docs/guides/web-app-integration.md) shows
how to build and install its npm tarball in another application, authorize a
runtime, send a prompt, and handle live tool calls.

The application-facing shape is meant to be agent- and harness-neutral:

```ts
const tools = [
  defineTool({
    name: "add_list_items",
    description: "Add several items to the current shopping list",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" } },
      },
      required: ["items"],
      additionalProperties: false,
    },
    execute: ({ items }) => shoppingList.addAll(items),
  }),
];

const connection = await connectAgent({
  baseUrl: runtimeCard.endpoint,
  appId: "my-shopping-list",
  tools,
  accessToken: approvedGrant,
});

for await (const event of connection.session.streamTask(prompt)) {
  renderAgentActivity(event);
}
```

The full guide includes signed runtime-card verification and the gateway
authorization redirect.

## Architecture

```text
Web application
  @agent-connect/web + application-owned tools
        │ HTTPS task/events and scoped tool results
        ▼
User-owned Agent Connect gateway
  gateway identity, consent, grants, opaque sessions
        │ internal provider adapter
        ▼
Omnigent ──ACP──> codex-acp ──> Codex
        │
        └── request-scoped MCP tool calls return to the web application
```

Omnigent HTTP/SSE is the first working provider transport. ACP is the preferred
downstream harness boundary. Neither Omnigent nor Codex types are part of the
application API. Future runtime and transport adapters
should preserve the web integration.

## Supported platforms

- Web SDK: modern HTTPS browsers with Fetch, SSE, Web Crypto, and Web Storage.
- Development: Node.js 22+ and npm 10+.
- Real gateway reference host: tested on Ubuntu 24.04 with Omnigent
  0.5.1, `codex-acp` 1.1.2, Codex CLI, and Tailscale Serve.

Other Linux distributions and architectures may work but have not passed the
complete real-Codex reference flow. Windows and macOS gateway hosting are not
currently tested.

## Security boundary

The runtime card pins the gateway public key before the app sends tools or
prompts. Tailscale authenticates the private transport user. Gateway-owned
consent and PKCE create a revocable capability bound to the exact application
and tool snapshot. These mechanisms authorize an application.

Treat every authorized app as a potentially adversarial principal. The real
reference profile is not a hardened sandbox for arbitrary hostile apps: Codex
can use its configured native capabilities inside the selected workspace, and
the runtime operator owns the machine's security posture. The public judge demo
contains no Codex credential or general agent shell.

See [the architecture documentation](docs/architecture/),
[the runtime threat model](docs/research/2026-07-14-malicious-application-runtime-threat-model.md),
and [the grant-route security retrospective](docs/plan/grant-route-security-retrospective.md).

## Develop and test

```sh
npm install
npm run verify
```

`npm run verify` runs formatting, type checks, gateway and SDK behavior tests,
and all builds without Omnigent, Tailscale, Codex credentials, or model usage.

Additional real-boundary checks:

```sh
# Pack the SDK, install it into a clean external npm project, and import it.
npm run test:package:web

# Start disposable real Omnigent services with a deterministic ACP agent.
npm run test:integration:omnigent
```

`npm run verify:full` adds the clean external SDK-package consumer and Canvas
Playwright suites to the default fast gate. It still does not consume model
credits. The real Omnigent provider test remains explicit because it starts
local services.

The provider-contract test exercises gateway → Omnigent → ACP → request-scoped
MCP → application result without using a model. The real gateway guide is the
manual milestone path using the user's Codex instance.

## Project status

This is a hackathon MVP and is still in hackathon MVP state.
The current boundary is one user, one online Omnigent host, one downstream
agent, one active task per app session, and one fixed tool snapshot per logical
session. Use at your own risk ^^.

See [the documentation index](docs/README.md), [mission](docs/mission.md), and
[accepted decisions](docs/decisions/).

## License

[MIT](LICENSE)
