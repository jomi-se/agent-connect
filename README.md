# Agent Connect

Bring your AI subscription to any web app.

Build AI features using the user's existing AI subscription instead of requiring
an API key or a second AI subscription from the application. A
small trusted authorization proxy privately operates stock OpenClaw's native
Responses endpoint. OpenClaw owns execution, context, tools, sandboxing and
subscription credentials. The owner accepted the Bookhand integration as a
prototype; known search/navigation defects and finer-grained smoke evidence are
tracked in the [closeout ledger](docs/plan/stock-openclaw-vertical-closeout.md).

## Built with Codex and GPT-5.6

Agent Connect was designed and implemented through Codex using GPT-5.6 Sol Medium for the most part. Codex
researched Omnigent and ACP, shaped the provider-neutral boundary, implemented
the SDK, gateway, authorization flow, test layers, Canvas demo, and real
browser-to-Codex composition, and debugged the deployed mobile flow.

The primary `/feedback` build thread is
`019f5c47-a462-73d0-a329-39013786bae4`.

## Legacy Canvas example

Open [agent-connect-demo.web.app](https://agent-connect-demo.web.app/) and
connect it to a gateway you operate using that gateway's public runtime card.

The demo includes three example apps: a project-board app with bulk editing,
in-place document review in a document editor, and product research in a
shopping app. It uses the Agent Connect browser SDK and the preserved runtime-card
gateway flow. It is useful historical product evidence, but it does not prove the
stock scoped proxy's OAuth + AI SDK path. Bookhand is the selected application
for that path's final owner acceptance. The published demo is not changed by
this branch.

The anonymous judge profile is retired; connect to a gateway you own.

## Run the stock OpenClaw scoped proxy

The [gateway guide](deploy/openclaw-gateway/README.md) covers isolated setup,
the pinned dependency and the private launcher. Use Node 24 LTS >=24.15 and <25.
OpenClaw must already be configured and running; the launcher does not select
its harness, manage credentials or restart personal services.

```sh
npm install
npm run build:scoped-proxy
cp deploy/openclaw-gateway/.env.scoped-proxy.example deploy/openclaw-gateway/.env.scoped-proxy
chmod 600 deploy/openclaw-gateway/.env.scoped-proxy
# Edit private literal values; follow the guide for new identity initialization.
export AGENT_CONNECT_OPENCLAW_ENV_FILE="$PWD/deploy/openclaw-gateway/.env.scoped-proxy"
node scripts/openclaw-scoped-proxy.mjs check
node scripts/openclaw-scoped-proxy.mjs serve
```

The proxy mediates private stock OpenClaw Responses. Tailscale Serve may provide
HTTPS reachability, but owner consent requires the explicit gateway enrollment
secret and never trusts a forwarding header as identity. The OpenClaw operator
token stays on the server. Config changes require supervised restart and fresh
consent; process restart ends in-memory continuations. The proxy also exposes
grant-scoped recent conversation listing and bounded native execution-history
reads. Completed heads can be reopened while the same grant and proxy process
remain live; inputs are deliberately labelled prompt-or-application-output, not
human-authored chat.

The published pinned runtime passes deterministic app-tool, continuation,
native-tool denial and sandbox-failure tests. These tests use fixture inference,
not subscription credentials, so the selected live subscription/browser flow is
still a separate acceptance gate.

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

const provider = await discoverOpenClawProvider({
  providerUrl: userOwnedGatewayUrl,
  experience: "https",
});
const authorization = await beginOpenClawAuthorization({
  provider,
  redirectUri: `${location.origin}/oauth/callback`,
  tools,
});
// Persist authorization.transaction, redirect to authorization.authorizationUrl,
// then exchange the callback with completeOpenClawAuthorization.

const model = createAiSdkOpenResponsesModel({
  endpoint: connection.endpoint,
  model: connection.model,
  getAccessToken,
});
const result = streamText({
  model,
  prompt,
  tools: createAiSdkApplicationTools(tools, { connectionId }),
  ...createAiSdkOpenResponsesGenerationOptions(previousResponseId),
});
```

The full guide includes PAR/PKCE transaction storage, token refresh, explicit
continuation checkpoints and revocation.

## Architecture

```text
Web application
  @open-agent-connect/web + application-owned tools
        │ Open Responses HTTP/SSE (POST /v1/responses)
        │ sequential calls & previous_response_id continuation
        ▼
User-owned Agent Connect gateway
  explicit owner login, consent, grants, bounded conversation ownership
        │ private operator-authenticated Open Responses
        ▼
OpenClaw → operator-configured runtime/model
  client function calls return through Agent Connect to the application
```

Open Responses HTTP/SSE is the standard public wire between applications and the
gateway. OpenClaw owns the runtime loop and provider integration. Agent Connect
retains the untrusted-application authorization boundary, not another agent
loop. See [ADR 0014](docs/decisions/0014-stock-openclaw-scoped-proxy.md).

## Supported platforms

- Web SDK: modern HTTPS browsers with Fetch, SSE, Web Crypto, and Web Storage.
- Development/operator checks: Node.js 24 LTS >=24.15 and <25.
- Scoped-proxy setup: pinned unpatched OpenClaw 2026.9.1, tested in isolation on this Linux VM.

Other Linux distributions and architectures may work but have not passed the
complete replacement acceptance flow. Windows and macOS gateway hosting are not
currently tested.

## Security boundary

The scoped client pins the configured HTTPS origin through exact OAuth metadata;
it does not independently attest the host or OpenClaw process. A saved enrollment
secret establishes the owner browser session; tailnet membership or
caller-provided identity headers do not. Gateway-owned consent and PKCE create a
revocable capability bound to the exact application and tool snapshot. The
runtime-card signature remains part of the preserved older gateway/Canvas flow.

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
npm run verify:scoped-proxy
```

`npm run verify:scoped-proxy` runs formatting checks, the standalone proxy build,
focused authority tests and real stock-OpenClaw compatibility/composition. It
requires the pin in `config/openclaw-test-compat.json` on PATH or at
`OPENCLAW_TEST_BIN`; install using the guide above. Only inference is
deterministic: no subscription credentials or model credits are needed.
A missing or mismatched dependency fails instead of skipping tests.

`npm run verify` remains the repository-wide compatibility gate, including
preserved historical implementation tests and all package builds.

For local maintainability diagnostics, run `npm run analyze`. It reports
complexity, dependency boundaries, unused code, and production duplication
without treating the current baseline as a refactoring mandate. See the
[code-quality analysis guide](docs/guides/code-quality-analysis.md) for the
rules and ratcheting policy.

Additional real-boundary checks:

```sh
# Run the isolated real-OpenClaw compatibility suite directly.
npm run test:integration:openclaw

# Run preserved legacy process-death evidence (not a scoped-proxy prerequisite).
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
The current boundary is one user, one private stock OpenClaw, one supervised
scoped proxy, preconfigured dedicated agents, one fixed tool snapshot per grant
conversation, and bounded process-local continuation. Use at your own risk ^^.

See [the documentation index](docs/README.md), [mission](docs/mission.md), and
[accepted decisions](docs/decisions/).

## License

[MIT](LICENSE)
