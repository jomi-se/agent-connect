# Agent Connect

Bring your own coding agent to any web app.

App developers want useful AI features, but metered API costs are a poor fit
for small products and BYOK still asks users to fund another usage bill. Agent
Connect lets a user connect a coding agent they already operate while the web
application lends it only the typed tools needed for the task.

The application does not install an MCP server into Codex, expose a provider
session id, or implement a different client for every agent harness.

## Try the public demo

Open [agent-connect-demo.web.app](https://agent-connect-demo.web.app/), paste
the runtime card supplied in the judge instructions, and connect with the
private enrollment passphrase on the connector-owned page.

The demo includes project-board bulk editing, in-place document review, and
product research. It exercises the real browser SDK, signed runtime identity,
connector-owned consent, PKCE grant, gateway, OmniGENT, ACP, request-scoped MCP,
browser tool execution, result return, and visible page mutation.

The public appliance uses disclosed deterministic, Codex-authored action plans
so anyone can test it without consuming a model account. It is not presented as
live model reasoning. The separate reference profile below runs the same path
with a real Codex instance and the user's own login.

## Run the real Codex reference profile

The [real connector guide](deploy/real-connector/README.md) starts the usable
MVP on a Linux machine:

```sh
curl -fsSL https://omnigent.ai/install.sh | sh
git clone https://github.com/jomi-se/agent-connect.git
cd agent-connect
npm install
npm run build

cp deploy/real-connector/.env.example deploy/real-connector/.env
# Configure Tailscale endpoint, user, dedicated CODEX_HOME, and workspace.
deploy/real-connector/run.sh
```

The supervisor runs a loopback Agent Connect gateway, OmniGENT server and host,
a narrow compatibility wrapper around the pinned `codex-acp` adapter, and a
real Codex process. Tailscale Serve publishes only the gateway over
authenticated HTTPS.

Previously unknown HTTPS applications can begin authorization without editing
the connector configuration or restarting it. The connector shows the exact
Origin, callback, scopes, and tools before approval. The resulting grant is
bound to that Origin, app id, redirect URI, scope set, and canonical tool
snapshot. The frozen anonymous judge profile deliberately keeps its fixed
application allowlist.

## Add Agent Connect to a web app

`@agent-connect/web` is a browser-safe TypeScript package. It is currently
distributed from source rather than the public npm registry. The
[web application integration guide](docs/guides/web-app-integration.md) shows
how to build and install its npm tarball in another application, authorize a
runtime, send a prompt, and handle live tool calls.

The application-facing shape is intentionally agent- and harness-neutral:

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

The full guide includes signed runtime-card verification and the connector
authorization redirect; `approvedGrant` is not an API key supplied by the app
developer.

## Architecture

```text
Web application
  @agent-connect/web + application-owned tools
        │ HTTPS task/events and scoped tool results
        ▼
User-owned Agent Connect gateway
  connector identity, consent, grants, opaque sessions
        │ internal provider adapter
        ▼
OmniGENT ──ACP──> codex-acp ──> Codex
        │
        └── request-scoped MCP tool calls return to the web application
```

OmniGENT HTTP/SSE is the first working provider transport. ACP is the preferred
downstream harness boundary. Neither OmniGENT, Codex, nor draft MCP-over-ACP
types are part of the application API. Future runtime and transport adapters
should preserve the web integration.

## Supported platforms

- Web SDK: modern HTTPS browsers with Fetch, SSE, Web Crypto, and Web Storage.
- Development: Node.js 22+ and npm 10+.
- Real connector reference host: tested on Ubuntu 24.04 ARM64 with OmniGENT
  0.5.1, `codex-acp` 1.1.2, Codex CLI, and Tailscale Serve.
- Public judge appliance: Linux with Docker Engine, Docker Compose v2, and
  Tailscale Funnel.

Other Linux distributions and architectures may work but have not passed the
complete real-Codex reference flow. Windows and macOS gateway hosting are not
currently claimed.

## Security boundary

The runtime card pins the connector public key before the app sends tools or
prompts. Tailscale authenticates the private transport user. Connector-owned
consent and PKCE create a revocable capability bound to the exact application
and tool snapshot. These mechanisms authorize an application; they do not make
that application trustworthy.

Treat every authorized app as a potentially adversarial principal. The real
reference profile is not a hardened sandbox for arbitrary hostile apps: Codex
can use its configured native capabilities inside the selected workspace, and
the runtime operator owns the machine's security posture. The public judge
appliance contains no Codex credential or general agent shell.

See [the architecture documentation](docs/architecture/),
[the runtime threat model](docs/research/2026-07-14-malicious-application-runtime-threat-model.md),
and [the grant-route security retrospective](docs/plan/grant-route-security-retrospective.md).

## Develop and test

```sh
npm install
npm run verify
```

`npm run verify` runs formatting, type checks, gateway and SDK behavior tests,
and all builds without OmniGENT, Tailscale, Codex credentials, or model usage.

Additional real-boundary checks:

```sh
# Pack the SDK, install it into a clean external npm project, and import it.
npm run test:package:web

# Start disposable real OmniGENT services with a deterministic ACP agent.
npm run test:integration:omnigent
```

The provider-contract test exercises gateway → OmniGENT → ACP → request-scoped
MCP → application result without using a model. The real connector guide is the
manual milestone path using the user's Codex instance.

## Built with Codex and GPT-5.6

Agent Connect was designed and implemented through Codex using GPT-5.6. Codex
researched OmniGENT and ACP, shaped the provider-neutral boundary, implemented
the SDK, gateway, authorization flow, test layers, public appliance, and real
browser-to-Codex composition, and debugged the deployed mobile flow.

One concrete example: while adapting the private Tailscale profile to a public
Funnel, a delegated Codex review treated the transport change as a trust-
boundary substitution and found that grant listing and revocation could
otherwise become anonymous. The finding was source-verified, fixed, and covered
by regression tests. The human builder chose the product direction, rejected
excessive scope and unsupported security claims, and performed the live mobile
and reboot tests.

The primary `/feedback` build thread is
`019f5c47-a462-73d0-a329-39013786bae4`.

## Project status

This is a hackathon MVP, not a production identity or orchestration platform.
The current boundary is one user, one online OmniGENT host, one downstream
agent, one active task per app session, and one fixed tool snapshot per logical
session. Durable unresolved tool delivery, DPoP sender binding, connector
credential recovery, a hardened real-agent sandbox, published packages, and
additional runtime adapters remain future work.

See [the documentation index](docs/README.md), [mission](docs/mission.md), and
[accepted decisions](docs/decisions/).

## License

[MIT](LICENSE)
