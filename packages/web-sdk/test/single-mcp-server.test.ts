import { describe, expect, it, vi } from "vitest";

import { McpBindingError } from "../src/single-mcp-server.js";
import { SingleMcpServer, defineTool } from "../src/index.js";

const VERSION_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

function createServer() {
  const execute = vi.fn(
    async (arguments_: { readonly range: string }) =>
      `values:${arguments_.range}`,
  );
  const server = new SingleMcpServer({
    serverId: "spreadsheet",
    name: "Spreadsheet",
    version: "0.0.1",
    instructions: "Read the open sheet.",
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

/** One MCP 2026-07-28 request over the binding. */
function request(
  method: string,
  params: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    serverId: "spreadsheet",
    requestId: "request-1",
    method,
    params: {
      ...params,
      _meta: {
        ...VERSION_META,
        ...((params["_meta"] as Record<string, unknown>) ?? {}),
      },
    },
    ...extra,
  };
}

describe("SingleMcpServer", () => {
  it("discovers, lists tools and calls a handler, each answer in the carrier", async () => {
    const { execute, server } = createServer();

    expect(server.descriptor).toEqual({
      type: "acp",
      name: "Spreadsheet",
      serverId: "spreadsheet",
    });
    await expect(server.message(request("server/discover"))).resolves.toEqual({
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        ttlMs: 0,
        cacheScope: "private",
        capabilities: { tools: { listChanged: false } },
        instructions: "Read the open sheet.",
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "Spreadsheet",
            version: "0.0.1",
          },
        },
      },
    });
    await expect(server.message(request("ping"))).resolves.toEqual({
      result: {},
    });
    await expect(server.message(request("tools/list"))).resolves.toEqual({
      result: {
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
      },
    });
    await expect(
      server.message(
        request(
          "tools/call",
          { name: "read_range", arguments: { range: "A1:B2" } },
          { _meta: { "agent-connect/actionId": "action-123" } },
        ),
      ),
    ).resolves.toEqual({
      result: { content: [{ type: "text", text: "values:A1:B2" }] },
    });
    expect(execute).toHaveBeenCalledWith(
      { range: "A1:B2" },
      {
        requestId: "request-1",
        toolName: "read_range",
        meta: { "agent-connect/actionId": "action-123" },
        actionId: "action-123",
      },
    );
  });

  it("answers MCP errors inside the carrier, so clients can fall back", async () => {
    const { server } = createServer();
    // The pre-2026 handshake is just an unknown method now.
    await expect(server.message(request("initialize"))).resolves.toEqual({
      error: { code: -32601, message: "Method not found: initialize" },
    });
    await expect(
      server.message(request("tools/call", { name: "missing", arguments: {} })),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    await expect(
      server.message({
        serverId: "spreadsheet",
        requestId: 2,
        method: "tools/list",
        params: {
          _meta: { "io.modelcontextprotocol/protocolVersion": "2025-06-18" },
        },
      }),
    ).resolves.toEqual({
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: ["2026-07-28"], requested: "2025-06-18" },
      },
    });
    await expect(
      server.message({
        serverId: "spreadsheet",
        requestId: 3,
        method: "tools/list",
      }),
    ).resolves.toMatchObject({ error: { code: -32602 } });
  });

  it("refuses another server ID as a binding failure, not an MCP error", async () => {
    const { server } = createServer();
    await expect(
      server.message({ ...request("tools/list"), serverId: "other" }),
    ).rejects.toBeInstanceOf(McpBindingError);
    await expect(
      server.message({ ...request("tools/list"), serverId: "other" }),
    ).rejects.toMatchObject({ code: -33001 });
  });

  it("returns handler failures as MCP tool errors without leaking stacks", async () => {
    const server = new SingleMcpServer({
      serverId: "spreadsheet",
      name: "Spreadsheet",
      version: "0.0.1",
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
    await expect(
      server.message(
        request("tools/call", { name: "write_range", arguments: {} }),
      ),
    ).resolves.toEqual({
      result: {
        content: [{ type: "text", text: "write rejected" }],
        isError: true,
      },
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

it("preserves inner MCP progress tokens while the gateway supplies the authoritative action ID", async () => {
  const { server, execute } = createServer();
  await server.message(
    request(
      "tools/call",
      {
        name: "read_range",
        arguments: { range: "A1" },
        _meta: {
          progressToken: "adapter-progress",
          "agent-connect/actionId": "untrusted-inner",
        },
      },
      {
        _meta: {
          progressToken: "outer-must-not-win",
          "agent-connect/actionId": "durable-gateway-action",
          trace: "retained",
        },
      },
    ),
  );
  expect(execute).toHaveBeenCalledWith(
    { range: "A1" },
    expect.objectContaining({
      actionId: "durable-gateway-action",
      meta: {
        progressToken: "adapter-progress",
        "agent-connect/actionId": "durable-gateway-action",
        trace: "retained",
      },
    }),
  );
});

it("ignores outer-only progress tokens and inner-only action IDs", async () => {
  const { server, execute } = createServer();
  await server.message(
    request(
      "tools/call",
      {
        name: "read_range",
        arguments: { range: "A1" },
        _meta: { "agent-connect/actionId": "untrusted-inner" },
      },
      { _meta: { progressToken: "not-an-MCP-token" } },
    ),
  );
  expect(execute).toHaveBeenCalledWith(
    { range: "A1" },
    expect.objectContaining({ actionId: undefined, meta: {} }),
  );
});
