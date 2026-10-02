# Agent Connect

Let a web app borrow **your own AI agent**. The app declares a small set of
approved tools; your gateway runs the harness, and those tools execute in the app.

**ACP prerelease candidate: 0.1.0-alpha.1.** ACP, MCP-over-ACP and resumable
transport APIs are unstable. Artifacts are validated locally and remain
unpublished until the owner approves the first release. ADR 0016 remains proposed.
The previous OpenClaw plugin remains in this repository and on npm.

## Install and try the ACP gateway

Requires Node 24 LTS (>=24.15, <25) and Docker. Supports Apple Silicon macOS,
Linux x64 and Linux ARM64; Windows is not yet supported. After publication:

```sh
npm install --global @open-agent-connect/gateway@0.1.0-alpha.1
agent-connect --help
```

For current local candidates, install the launcher and matching platform tarballs.
The [install guide](docs/install/README.md) is the complete path from release
artifacts to a chat turn: install, run the standalone sample using the packed SDK,
approve its tools, create a private grant/config, perform one dedicated Codex
login, then start the Docker egress proxy and gateway. No checkout or compiler
is required. The guide also covers upgrades, revocation and uninstalling.

```text
Web app (@open-agent-connect/web/acp + approved application tools)
   │ grant-authorized ACP WebSocket / resumable transport
   ▼
Your Rust gateway (agent-connect CLI)
   │ filters browser authority; one container per session
   ▼
Pinned adapter + unmodified Codex or Claude Code CLI
   │ dedicated shared login/home; constrained network egress
   ▼
Your provider
```

The current ACP grant is operator-issued for an exact browser origin and tool
snapshot; there is no OAuth pairing portal on this path. A dedicated shared home
holds credentials, configuration and transcripts. A consented application could
induce the harness to disclose that dedicated credential through an allowed tool,
or read another app's transcripts. Read the [accepted risks](docs/plan/acp-gateway-credentials.md)
before logging in. Claude Code subscription use is unconfirmed against Anthropic
terms. API-key variables are never forwarded into boxes.

## Integrate a web app

```sh
npm install @open-agent-connect/web@0.1.0-alpha.1
```

```ts
import {
  connectAgent,
  defineTool,
  AgentSession,
} from "@open-agent-connect/web/acp";

const tools = [
  defineTool({
    name: "read_selection",
    description: "Read the current selection",
    inputSchema: { type: "object", additionalProperties: false },
    execute: () => window.getSelection()?.toString() ?? "",
  }),
];
// grant is supplied by the operator, not hard-coded or stored in a URL.
const provider = await connectAgent({ grant, tools });
const session = new AgentSession({ provider, tools });
const result = await session.runTask("Explain the selected text");
provider.close();
```

See the [SDK quickstart](packages/web-sdk/README.md) for tools, typed errors,
reconnect/recovery and the AI SDK `createAcpChatTransport`/`useChat` integration.
Recovery never automatically re-sends interrupted prompts or uncertain effects.
The [standalone sample](examples/acp-chat/) consumes only public packed exports.

## Previous OpenClaw installation

The published `@open-agent-connect/openclaw-plugin@0.0.7` remains available, with
its [installation guide](deploy/openclaw-gateway/README.md) and Canvas demo in
[apps/firebase-canvas](apps/firebase-canvas/). Its OAuth/Open Responses SDK
exports are retained and marked deprecated for new integrations, not removed.
There is no automatic grant/history migration. ADR acceptance and any future
plugin retirement remain separate owner decisions.

## Develop and validate

```sh
npm install
npm run verify
cargo test --locked
```

The [build/release guide](docs/install/release.md) lists Rust, cargo-dist, Zig,
pinned OpenClaw, Playwright and Docker prerequisites, local artifact generation
and the credential-free clean-room test. Verification exercises real pinned
adapters against deterministic inference and never spends subscription allowance.
The release workflows are written; running them and publishing remain owner actions.

## License

[MIT](LICENSE)
