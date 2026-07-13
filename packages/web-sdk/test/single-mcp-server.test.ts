import { describe, expect, it, vi } from "vitest";

import { McpOverAcpError, SingleMcpServer, defineTool } from "../src/index.js";

function createServer() {
  const execute = vi.fn(
    async (arguments_: { readonly range: string }) =>
      `values:${arguments_.range}`,
  );
  const server = new SingleMcpServer({
    serverId: "spreadsheet",
    name: "Spreadsheet",
    version: "0.0.1",
    createConnectionId: () => "mcp-connection-1",
    tools: [
      defineTool({
        name: "read_range",
        description: "Read cells",
        inputSchema: {
          type: "object",
          properties: { range: { type: "string" } },
          required: ["range"],
        },
        execute,
      }),
    ],
  });
  return { execute, server };
}

describe("SingleMcpServer", () => {
  it("connects, initializes, lists tools, and calls a handler", async () => {
    const { execute, server } = createServer();

    expect(server.descriptor).toEqual({
      type: "acp",
      name: "Spreadsheet",
      serverId: "spreadsheet",
    });
    expect(server.connect({ serverId: "spreadsheet" })).toEqual({
      connectionId: "mcp-connection-1",
    });

    await expect(
      server.message({
        connectionId: "mcp-connection-1",
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    ).resolves.toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "Spreadsheet", version: "0.0.1" },
    });

    await expect(
      server.message({
        connectionId: "mcp-connection-1",
        method: "tools/list",
      }),
    ).resolves.toEqual({
      tools: [
        {
          name: "read_range",
          description: "Read cells",
          inputSchema: {
            type: "object",
            properties: { range: { type: "string" } },
            required: ["range"],
          },
        },
      ],
    });

    await expect(
      server.message({
        connectionId: "mcp-connection-1",
        method: "tools/call",
        params: { name: "read_range", arguments: { range: "A1:B2" } },
        _meta: { "agent-connect/actionId": "action-123" },
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "values:A1:B2" }],
    });
    expect(execute).toHaveBeenCalledWith(
      { range: "A1:B2" },
      {
        connectionId: "mcp-connection-1",
        toolName: "read_range",
        meta: { "agent-connect/actionId": "action-123" },
        actionId: "action-123",
      },
    );
  });

  it("rejects messages before initialization", async () => {
    const { server } = createServer();
    server.connect({ serverId: "spreadsheet" });

    await expect(
      server.message({
        connectionId: "mcp-connection-1",
        method: "tools/list",
      }),
    ).rejects.toMatchObject({
      name: "McpOverAcpError",
      code: -32600,
    });
  });

  it("rejects unknown servers, duplicate connections, and unknown tools", async () => {
    const { server } = createServer();

    expect(() => server.connect({ serverId: "other" })).toThrow(
      McpOverAcpError,
    );
    server.connect({ serverId: "spreadsheet" });
    expect(() => server.connect({ serverId: "spreadsheet" })).toThrow(
      /already has an active connection/,
    );
    await server.message({
      connectionId: "mcp-connection-1",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    await expect(
      server.message({
        connectionId: "mcp-connection-1",
        method: "tools/call",
        params: { name: "missing", arguments: {} },
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("returns handler failures as MCP tool errors without leaking stacks", async () => {
    const server = new SingleMcpServer({
      serverId: "spreadsheet",
      name: "Spreadsheet",
      version: "0.0.1",
      createConnectionId: () => "connection",
      tools: [
        defineTool({
          name: "write_range",
          description: "Write cells",
          inputSchema: { type: "object" },
          execute: () => {
            throw new Error("write rejected");
          },
        }),
      ],
    });
    server.connect({ serverId: "spreadsheet" });
    await server.message({
      connectionId: "connection",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });

    await expect(
      server.message({
        connectionId: "connection",
        method: "tools/call",
        params: { name: "write_range", arguments: {} },
      }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "write rejected" }],
      isError: true,
    });
  });

  it("allows a fresh logical connection after disconnect", () => {
    const { server } = createServer();
    server.connect({ serverId: "spreadsheet" });
    expect(server.disconnect({ connectionId: "mcp-connection-1" })).toEqual({});
    expect(server.connect({ serverId: "spreadsheet" })).toEqual({
      connectionId: "mcp-connection-1",
    });
  });

  it("rejects duplicate tool names at construction", () => {
    const tool = defineTool({
      name: "read_range",
      description: "Read cells",
      inputSchema: { type: "object" },
      execute: () => undefined,
    });

    expect(
      () =>
        new SingleMcpServer({
          serverId: "spreadsheet",
          name: "Spreadsheet",
          version: "0.0.1",
          tools: [tool, tool],
        }),
    ).toThrow(/Duplicate application tool/);
  });
});
