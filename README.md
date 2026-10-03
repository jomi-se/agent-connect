# Agent Connect

Let a web app borrow **your own AI agent**. The app declares a small set of
approved tools; your gateway runs the harness, and those tools execute in the app.

**ACP prerelease candidate: 0.1.0-alpha.1.** ACP, MCP-over-ACP and resumable
transport APIs are unstable. Artifacts are validated locally and remain
unpublished until the owner approves the first release. ADR 0016 remains proposed.
The previous OpenClaw plugin remains in this repository and on npm.

## Install and try the ACP gateway

The gateway launcher requires Node >=24.15 and Docker. Development and
provider compatibility checks use Node 24 LTS (>=24.15, <25). Supports Apple Silicon macOS,
Linux x64 and Linux ARM64; Windows is not yet supported. After publication:

```sh
npm install --global @open-agent-connect/gateway@0.1.0-alpha.1
agent-connect --help
agent-connect setup
```

For current local candidates, install the launcher and matching platform tarballs.
The [install guide](docs/install/README.md) is the complete path from release
artifacts to a chat turn: install, run guided setup, complete your dedicated
provider login, then connect through hosted owner consent. For your own HTTPS
entry point, use `agent-connect setup --origin https://gateway.example`.
`agent-connect doctor` checks the installation and `agent-connect service`
manages its user service. No checkout or compiler is required. The guide covers
the sample app, troubleshooting, upgrades, recovery and uninstalling.

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

The gateway hosts owner sign-in and OAuth consent. Each application requests
access for its exact browser origin and fixed tool snapshot; the owner chooses
the duration and can revoke individual grants without restarting. Owner
passphrases and optional TOTP enrollment stay outside the harness home.
A dedicated shared home
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
  captureAcpPairingCallback,
  connectAgent,
  defineTool,
  AgentSession,
} from "@open-agent-connect/web/acp";

// Run at page startup to remove OAuth response values from the URL.
const callbackUrl = captureAcpPairingCallback();
if (callbackUrl && window.opener) window.close();

const tools = [
  defineTool({
    name: "read_selection",
    description: "Read the current selection",
    inputSchema: { type: "object", additionalProperties: false },
    execute: () => window.getSelection()?.toString() ?? "",
  }),
];
// Invoke directly from a user click so the consent popup can open.
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
connectButton.addEventListener("click", async () => {
  const provider = await connectAgent({
    gatewayUrl: "https://gateway.example",
    tools,
    pairing: {
      mode: "popup",
      redirectUri: location.origin + location.pathname,
    },
  });
  const session = new AgentSession({ provider, tools });
  await session.runTask("Explain the selected text");
  provider.close();
});
```

For mobile browsers use an explicit `pairing.mode: "redirect"` action and
complete the callback on return. The default `resume` mode only reuses or
completes a managed grant; it never opens consent automatically. Grants use
session-scoped browser storage, rotating refresh tokens and stable grant IDs.
A revoked grant requires a new explicit Connect action.

See the [SDK quickstart](packages/web-sdk/README.md) for tools, typed errors,
reconnect/recovery and the AI SDK `createAcpChatTransport`/`useChat` integration.
Recovery never automatically re-sends interrupted prompts or uncertain effects.
The [standalone sample](examples/acp-chat/) consumes only public packed exports.

## Previous OpenClaw installation

The published `@open-agent-connect/openclaw-plugin@0.0.7` remains available, with
its [installation guide](deploy/openclaw-gateway/README.md) and Canvas demo in
[apps/firebase-canvas](apps/firebase-canvas/). Its OAuth/Open Responses SDK
exports are retained and marked deprecated for new integrations, not removed.
Trying ACP starts a fresh private runtime and pairs apps again; plugin grants,
histories and personal provider logins are never imported. ADR acceptance and
any future plugin retirement remain separate owner decisions.

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
