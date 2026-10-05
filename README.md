# Agent Connect

**Connect your AI.** Let a web application use the agent you already own.
The application supplies its UI and a fixed set of approved tools; your gateway
provides scoped access to your chosen harness and model.

One product: the Rust gateway (`agent-connect`) and browser SDK
(`@open-agent-connect/web`). Gateway **0.0.1** and SDK **0.0.10** are early alpha
releases. ACP, MCP-over-ACP and transport resumption are **experimental and
unstable**. [ADR 0016](docs/decisions/0016-acp-application-boundary.md), accepted
on 2026-10-04, establishes ACP as the product vision and chosen open standard.

## Run your gateway

Install from npm. You need Node 24 LTS (>=24.15), Docker, a browser and a Codex
or Claude Code subscription; see the [install guide](docs/install/README.md).

```sh
npm install --global @open-agent-connect/gateway
agent-connect setup
agent-connect login
agent-connect doctor
agent-connect service start
```

Setup creates private owner state, owned egress and a user service, which it
starts automatically. Run provider login yourself in the dedicated harness home;
read the [shared-home risks](docs/plan/credentials.md) first. The explicit start
command also starts a previously stopped service. For remote access, follow the
install guide's HTTPS setup.

Open an app that supports Agent Connect, enter your gateway origin and choose
**Connect**. Sign in on the gateway's owner page and approve the exact app origin,
tool snapshot, restricted profile and duration. Try the
[standalone chat sample](examples/acp-chat/README.md).

## Add it to your application

Install `@open-agent-connect/web@0.0.10` after publication, or its supplied tarball
beforehand. Import from the package root. Call pairing from an explicit user
action, then pass the returned transport to AI SDK `useChat`:

```ts
import {
  captureAcpPairingCallback,
  connectAgent,
  createAcpChatTransport,
  defineTool,
} from "@open-agent-connect/web";

const callbackUrl = captureAcpPairingCallback(); // Before rendering the callback.
const tools = [
  defineTool({
    name: "read_note",
    description: "Read the open note",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: () => "The note belongs to this application.",
  }),
];

export async function connectNotes(gatewayUrl: string) {
  const provider = await connectAgent({
    gatewayUrl,
    tools,
    pairing: {
      mode: "popup",
      redirectUri: window.location.origin + window.location.pathname,
      ...(callbackUrl ? { callbackUrl } : {}),
      clientName: "Notes",
    },
  });
  return { provider, transport: createAcpChatTransport({ provider, tools }) };
}
```

The harness owns history and the tool loop. The transport validates and executes
approved app tools. Effects need application-owned idempotency or action-ID
deduplication; recovery never replays an uncertain prompt or effect. Close the
transport and provider when leaving the feature. The
[SDK guide](packages/web-sdk/README.md) covers React, tools, recovery and errors.

## Develop

Use Node 24 LTS >=24.15 and <25. The [release guide](docs/install/release.md)
provides pinned tools, local artifact builds and the full verification sequence.
Tests exercise real pinned adapters with deterministic inference; real-model
application acceptance is separate evidence.

- [Documentation](docs/README.md), [mission](docs/mission.md) and [architecture](docs/architecture/target-architecture.md)
- [Configuration](docs/install/configuration.md) and [troubleshooting](docs/install/troubleshooting.md)
- [Current work and owner gates](docs/plan/current-work.md)
- [Testing strategy](docs/architecture/testing-strategy.md)

## License

MIT
