# `@agent-connect/web`

A browser-safe, harness-neutral API for lending temporary application tools to
a user-owned agent runtime. OmniGENT is the first provider; its HTTP/SSE and
tool-result wire shapes stay behind the provider adapter.

```ts
import { connectAgent, defineTool } from "@agent-connect/web";

const connection = await connectAgent({
  baseUrl: "https://my-user-runtime.example",
  appId: "my-spreadsheet",
  pairingCode: codeEnteredByTheUser,
  tools: [
    defineTool({
      name: "read_range",
      description: "Read cells from the current spreadsheet",
      inputSchema: {
        type: "object",
        properties: { range: { type: "string" } },
        required: ["range"],
      },
      execute: async ({ range }) => JSON.stringify(await sheet.read(range)),
    }),
  ],
});

for await (const event of connection.session.streamTask(
  "Clean up the selected table",
)) {
  renderAgentEvent(event);
}
```

`AgentSession` snapshots the tool set at task start, validates tool arguments
against JSON Schema in the browser, suppresses repeated action IDs within that
live task, and exposes provider-neutral task/text/tool events. Session
provisioning and pairing belong to the user-owned runtime. `connectAgent`
exchanges a one-time code for an expiring capability and returns only an opaque
Agent Connect session id; OmniGENT conversation ids stay internal. Reconnect
with `accessToken: connection.accessToken` while that capability remains valid.
`revokeAgentAuthorization` lets the application revoke its own grant with that
bearer credential. A revoked or expired grant is surfaced as the typed
`invalid_app_grant` error so applications can discard stale local state and
start authorization again.

The package also retains the deliberately narrow `SingleMcpServer` and
`createBrowserAcpStream` experimental ACP/MCP-over-ACP helpers. They are not on
the first provider's critical path.

## Current constraints

- one online OmniGENT host, selected explicitly when more than one is online;
- one active task per provider instance;
- a fixed tool snapshot per task;
- in-memory duplicate suppression only, not durable exactly-once execution;
- session/capability state is in-memory and does not survive a gateway restart;
- no application-owned mutation approval or durable provider-session recovery
  yet;
- the experimental MCP-over-ACP helper still supports only one connection and
  MCP `initialize`, `notifications/initialized`, `ping`, `tools/list`, and
  `tools/call`.
