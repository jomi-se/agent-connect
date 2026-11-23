import type { McpOperationContext } from "@agentclientprotocol/sdk/unstable";
import { describe, expect, it, vi } from "vitest";

import { SingleMcpServer, defineTool } from "../src/index.js";

const signal = new AbortController().signal;
const notify = vi.fn(async () => {});

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

/**
 * One MCP 2026-07-28 operation as the ACP SDK's MCP-over-ACP provider hands
 * it over, after checking the server ID, version and capabilities.
 */
function request(
  method: string,
  params: Record<string, unknown> = {},
  extra: { readonly _meta?: Record<string, unknown> } = {},
): McpOperationContext {
  return {
    serverId: "spreadsheet",
    requestId: "request-1",
    method,
    params,
    protocolVersion: "2026-07-28",
    clientCapabilities: {},
    clientInfo: undefined,
    envelopeMeta: extra._meta,
    signal,
    notify,
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
    await expect(server.handle(request("server/discover"))).resolves.toEqual({
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
    await expect(server.handle(request("ping"))).resolves.toEqual({
      result: {},
    });
    await expect(server.handle(request("tools/list"))).resolves.toEqual({
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
      server.handle(
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
        signal,
        notify,
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
    await expect(server.handle(request("initialize"))).resolves.toEqual({
      error: { code: -32601, message: "Method not found: initialize" },
    });
    await expect(
      server.handle(request("tools/call", { name: "missing", arguments: {} })),
    ).resolves.toMatchObject({ error: { code: -32602 } });
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
      server.handle(
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
  await server.handle(
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
  await server.handle(
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
