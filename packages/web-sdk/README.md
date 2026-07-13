# `@agent-connect/web`

Browser-oriented ACP helpers for applications that lend temporary tools to a user-owned agent runtime.

The package currently implements a deliberately narrow and unstable MCP-over-ACP server profile. It composes the official ACP TypeScript SDK; it does not define a competing agent session protocol.

```ts
import {
  createBrowserAcpStream,
  defineTool,
  SingleMcpServer,
} from "@agent-connect/web";

const spreadsheetTools = new SingleMcpServer({
  serverId: "spreadsheet",
  name: "Spreadsheet tools",
  version: "0.0.1",
  tools: [
    defineTool({
      name: "read_range",
      description: "Read cells from the current spreadsheet",
      inputSchema: {
        type: "object",
        properties: { range: { type: "string" } },
        required: ["range"],
      },
      execute: async (arguments_) =>
        JSON.stringify(await sheet.read(arguments_.range)),
    }),
  ],
});

const stream = createBrowserAcpStream("wss://runtime.example/acp");
const mcpServer = spreadsheetTools.descriptor;
```

The next integration step registers `spreadsheetTools.connect`, `message`, and `disconnect` as ACP client-side handlers and includes `mcpServer` in `session/new.mcpServers`.

## Current constraints

- one MCP server instance;
- one active logical connection;
- a fixed tool set;
- MCP `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call` only;
- reconnect and pending-action durability are conductor responsibilities and are not implemented in this package yet.
