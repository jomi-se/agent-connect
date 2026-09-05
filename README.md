# Agent Connect

Bring your AI subscription to any web app.

Build AI features using the user's existing AI subscription instead of requiring
an API key or a second AI subscription from the application. This branch replaces
the original backend with an OpenClaw policy
gateway. The selected runtime is OpenClaw's built-in loop using the user's
subscription; live browser acceptance remains open.

## Built with Codex and GPT-5.6

Agent Connect was designed and implemented through Codex using GPT-5.6 Sol Medium for the most part. Codex
researched Omnigent and ACP, shaped the provider-neutral boundary, implemented
the SDK, gateway, authorization flow, test layers, Canvas demo, and real
browser-to-Codex composition, and debugged the deployed mobile flow.

The primary `/feedback` build thread is
`019f5c47-a462-73d0-a329-39013786bae4`.

## Try the Canvas application

Open [agent-connect-demo.web.app](https://agent-connect-demo.web.app/) and
connect it to a gateway you operate using that gateway's public runtime card.

The demo includes three example apps: a project-board app with bulk editing,
in-place document review in a document editor, and product research in a
shopping app. It uses the Agent Connect browser SDK and gateway. The published
demo and existing personal installation are not changed by this branch.

The anonymous judge profile is retired; connect to a gateway you own.

## Run the OpenClaw replacement

The [gateway guide](deploy/openclaw-gateway/README.md) covers isolated setup,
the pinned dependency and the private launcher. Use Node 24 LTS >=24.15 and <25.
OpenClaw must already be configured and running; the launcher does not select
its harness, manage credentials or restart personal services.

```sh
npm install
npm run build
cp deploy/openclaw-gateway/.env.example deploy/openclaw-gateway/.env
chmod 600 deploy/openclaw-gateway/.env
# Edit private literal values; follow the guide for new identity initialization.
export AGENT_CONNECT_OPENCLAW_ENV_FILE="$PWD/deploy/openclaw-gateway/.env"
node scripts/openclaw-gateway.mjs check
node scripts/openclaw-gateway.mjs serve
```

The gateway mediates private OpenClaw Responses. Tailscale Serve can expose only
Agent Connect over authenticated HTTPS. OpenClaw's operator token stays on the
server. Preserve existing identity state during migration; old Omnigent
conversations cannot become OpenClaw conversations.

The pinned built-in OpenClaw loop passes deterministic client-tool tests, but
its native Codex adapter drops those tools. The built-in loop also projects
client output as user text. See the [measured findings](docs/research/2026-09-05-openclaw-replacement.md):
this is not yet a proven subscription-backed replacement.

On a first connection, the gateway shows the exact
Origin, callback, scopes, and tools before approval. The resulting grant is
bound to that Origin, app id, redirect URI, scope set, and tool
snapshot.

## Add Agent Connect to a web app

`@open-agent-connect/web` is a browser-safe TypeScript package published to
npm as [`@open-agent-connect/web`](https://www.npmjs.com/package/@open-agent-connect/web).
It is versioned `0.0.x` while the wire format settles. The
[web application integration guide](docs/guides/web-app-integration.md) shows
how to install it in another application, authorize a runtime, send a prompt,
and handle live tool calls.

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
  @open-agent-connect/web + application-owned tools
        │ Open Responses HTTP/SSE (POST /v1/responses)
        │ sequential calls & previous_response_id continuation
        ▼
User-owned Agent Connect gateway
  identity, consent, grants, profile and durable call ownership
        │ private operator-authenticated Open Responses
        ▼
OpenClaw → operator-configured runtime/model
  client function calls return through Agent Connect to the application
```

Open Responses HTTP/SSE is the standard public wire between applications and the
gateway. OpenClaw owns the runtime loop and provider integration. Agent Connect
retains the untrusted-application boundary and durable ownership checks, not
another agent loop. See [ADR 0012](docs/decisions/0012-openclaw-policy-gateway.md).

## Supported platforms

- Web SDK: modern HTTPS browsers with Fetch, SSE, Web Crypto, and Web Storage.
- Development/operator checks: Node.js 24 LTS >=24.15 and <25.
- Replacement setup: pinned OpenClaw 2026.9.1, tested in isolation on this Linux VM.

Other Linux distributions and architectures may work but have not passed the
complete replacement acceptance flow. Windows and macOS gateway hosting are not
currently tested.

## Security boundary

The runtime card pins the gateway public key before the app sends tools or
prompts. Tailscale authenticates the private transport user. Gateway-owned
consent and PKCE create a revocable capability bound to the exact application
and tool snapshot. These mechanisms authorize an application.

Treat every authorized app as a potentially adversarial principal. The real
profile is not a hardened sandbox for arbitrary hostile apps. The selected
OpenClaw agent must have host tools disabled and its capabilities verified;
checking the app snapshot alone does not confine a runtime. The operator owns
the machine's security posture.

See [the architecture documentation](docs/architecture/),
[the runtime threat model](docs/research/2026-07-14-malicious-application-runtime-threat-model.md),
and [the grant-route security retrospective](docs/plan/grant-route-security-retrospective.md).

Contributors can install the checksum-pinned staged-secret hook with
`npm run security:hooks:install` and scan all reachable history with
`npm run security:scan`. Local hooks are a guardrail, not an unbypassable
security boundary; GitHub secret scanning and push protection provide the
server-side backstop.

## Develop and test

```sh
npm install
npm run verify
```

`npm run verify` runs formatting checks, type checks, unit and behavior tests,
all package builds, real-OpenClaw compatibility and process-crash tests. It
requires the pin in `config/openclaw-test-compat.json` on PATH or at
`OPENCLAW_TEST_BIN`; install using the guide above. Only inference is
deterministic: no subscription credentials or model credits are needed.
A missing or mismatched dependency fails instead of skipping tests.

For local maintainability diagnostics, run `npm run analyze`. It reports
complexity, dependency boundaries, unused code, and production duplication
without treating the current baseline as a refactoring mandate. See the
[code-quality analysis guide](docs/guides/code-quality-analysis.md) for the
rules and ratcheting policy.

Additional real-boundary checks:

```sh
# Run the isolated real-OpenClaw compatibility suite directly.
npm run test:integration:openclaw

# Test gateway response durability across process death.
npm run test:integration:response-crash

# Pack the SDK, install it into a clean external npm project, and import it.
npm run test:package:web
```

`npm run verify:full` adds the clean external SDK-package consumer fixture,
WebMCP checks, and Canvas Playwright browser suites to the
default verification gate.

See the [testing strategy guide](docs/architecture/testing-strategy.md) for how
Agent Connect separates pure state-machine invariants, deterministic real-dependency
compatibility tests, and selected subscription-runtime composition smoke tests.

## Project status

This is a hackathon MVP and is still in hackathon MVP state.
The current boundary is one user, one private OpenClaw gateway, one configured
agent, one active task per app session, and one fixed tool snapshot per logical
session. Use at your own risk ^^.

See [the documentation index](docs/README.md), [mission](docs/mission.md), and
[accepted decisions](docs/decisions/).

## License

[MIT](LICENSE)
