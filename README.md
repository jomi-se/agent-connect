# Agent Connect

Bring your AI subscription to any web app.

Build AI features using the user's existing AI subscription instead of requiring
an application API key or a second subscription. Agent Connect installs as a
plugin in the user's stock OpenClaw gateway. It adds an application-scoped OAuth
and Open Responses boundary while OpenClaw continues to own execution, context,
tools, sandboxing, models, and provider credentials. Applications see a
harness-neutral gateway API; OpenClaw and other provider adapters stay behind it.

The current release targets one user-owned gateway, independent app
conversations, one active request per conversation, an owner-selected restricted
agent, and a fixed approved application-tool snapshot. Conversation ownership
and continuation state are bounded and process-local, so restart ends them and
uncertain application effects are never replayed automatically.

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
shopping app. It uses the Agent Connect browser SDK and the historical runtime-card
gateway flow. It is useful product evidence, but it does not prove the current
plugin-hosted OAuth + AI SDK path. Bookhand is the selected application for that
path's owner acceptance. The published demo is unchanged.

The anonymous judge profile is retired; connect to a gateway you own.

## Install the OpenClaw plugin

Use Node 24 LTS >=24.15 and <25 with OpenClaw 2026.9.1 or newer. CI and the
reference deployment pin 2026.9.1 as their reproducible known-good version; the
plugin does not impose an upper OpenClaw version bound. Install it through
OpenClaw's supported package flow and explicitly accept its declared host
capabilities:

```sh
openclaw plugins install @open-agent-connect/openclaw-plugin@0.0.2 --pin --accept-capabilities
openclaw agent-connect setup
# Restart the gateway, then:
openclaw agent-connect doctor
```

On a terminal, no-argument `setup` asks for the public HTTPS origin, dedicated
loopback application port (default `18790`), and optional restricted-agent model,
shows one bounded summary, and applies only after
confirmation. Existing automation keeps the old preview/apply contract:

```sh
openclaw agent-connect setup --origin https://your-gateway.example --json
openclaw agent-connect setup --origin https://your-gateway.example --apply --non-interactive
```

The first successful apply prints a one-time owner enrollment passphrase. Put it
directly in the owner's password manager; it is not stored in plaintext or shown
again. Setup preserves unrelated OpenClaw agents and configuration, refuses
unsupported conflicts, and creates a dedicated app agent with native tools denied
by default. It does not copy credentials, grants, conversations, or owner state
from older Agent Connect deployments.

Bind OpenClaw to loopback and forward public HTTPS to the plugin's dedicated
loopback port, never the native OpenClaw port. Native UI, RPC, terminal and
`/v1/responses` routes do not exist on the plugin listener. The OpenClaw
operator credential remains server-side and is never an application credential. The
[gateway guide](deploy/openclaw-gateway/README.md) covers setup, doctor states,
coexistence, ingress, and recovery limitations. The superseded standalone proxy
is available through git history, not the current build or deployment surface.

The pinned real OpenClaw host passes deterministic package-install, application
tool, continuation, native-tool denial, lifecycle, and sandbox-failure tests.
Fixture inference spends no subscription allowance; a selected live
subscription/browser smoke remains separate evidence.

On a first connection, the gateway shows the exact
Origin, callback, scopes, and tools before approval. The resulting grant is
bound to that Origin, app id, redirect URI, scope set, and tool
snapshot.

## Add Agent Connect to a web app

`@open-agent-connect/web` is a browser-safe TypeScript package on
npm as [`@open-agent-connect/web`](https://www.npmjs.com/package/@open-agent-connect/web).
This checkout prepares `0.0.4`; it remains versioned `0.0.x` while the wire
format settles. The
[web application integration guide](docs/guides/web-app-integration.md) shows
how to install it in another application, authorize a runtime, send a prompt,
and handle live tool calls.

```sh
npm install @open-agent-connect/web@0.0.4
```

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
        │ Open Responses HTTP/SSE (POST /agent-connect/v1/responses)
        │ sequential calls & previous_response_id continuation
        ▼
User-owned Agent Connect gateway
  explicit owner login, consent, grants, bounded conversation ownership
        │ namespaced plugin routes inside the same stock host
        ▼
Stock OpenClaw → operator-configured runtime/model
  client function calls return through Agent Connect to the application
```

Open Responses HTTP/SSE is the public wire between applications and the gateway;
the plugin keeps it under the `/agent-connect` namespace. OpenClaw owns the
runtime loop and provider integration. Agent Connect retains the
untrusted-application authorization boundary, not another agent loop or proxy
process. See
[ADR 0015](docs/decisions/0015-openclaw-plugin-host.md).

## Supported platforms

- Web SDK: modern HTTPS browsers with Fetch, SSE, Web Crypto, and Web Storage.
- Development/operator checks: Node.js 24 LTS >=24.15 and <25.
- Gateway plugin: pinned stock OpenClaw 2026.9.1 on Node >=24.15 and <25,
  exercised through disposable real-host package installation on Linux.

Other Linux distributions and architectures may work but have not passed the
complete replacement acceptance flow. Windows and macOS gateway hosting are not
currently tested.

## Security boundary

The client pins the configured HTTPS provider path through exact OAuth metadata;
it does not independently attest the host or OpenClaw process. A saved enrollment
passphrase establishes the owner browser session; tailnet membership or
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
npm run verify
```

`npm run verify` is the repository compatibility gate. It includes the installed
plugin-host composition against the exact OpenClaw pin in
`config/openclaw-test-compat.json`; put that binary on `PATH` or set
`OPENCLAW_TEST_BIN`. A missing or mismatched dependency fails instead of skipping.
The tests use deterministic inference and no subscription credentials.

For local maintainability diagnostics, run `npm run analyze`. It reports
complexity, dependency boundaries, unused code, and production duplication
without treating the current baseline as a refactoring mandate. See the
[code-quality analysis guide](docs/guides/code-quality-analysis.md) for the
rules and ratcheting policy.

Additional real-boundary checks:

```sh
# Run the isolated real-OpenClaw compatibility suite directly.
npm run test:integration:openclaw

# Run preserved historical replacement-engine process-death evidence.
npm run test:integration:response-crash

# Pack the SDK, install it into a clean external npm project, and import it.
npm run test:package:web

# Pack and inspect both release candidates without publishing.
npm run release:prepare
```

`npm run verify:full` adds the clean external SDK-package consumer fixture,
release workflow logic checks, WebMCP checks, and Canvas Playwright browser
suites. Publishing is restricted to the successful main-branch CI job; local
commands never publish unless `npm run release:publish` is invoked deliberately
with npm publication authority.

See the [testing strategy guide](docs/architecture/testing-strategy.md) for how
Agent Connect separates pure state-machine invariants, deterministic real-dependency
compatibility tests, and selected subscription-runtime composition smoke tests.

## Project status

This is an early `0.x` system, not a claim of a hardened general-purpose agent
sandbox. The stock plugin host is the sole installation target; the first npm
release and fresh Artifex deployment remain owner-gated. The prior Canvas
runtime-card demo is historical product evidence, not a setup prerequisite. Use
at your own risk ^^.

See [the documentation index](docs/README.md), [mission](docs/mission.md), and
[accepted decisions](docs/decisions/).

## License

[MIT](LICENSE)
