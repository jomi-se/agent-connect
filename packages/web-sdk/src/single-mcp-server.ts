import type {
  ConnectMcpRequest,
  ConnectMcpResponse,
  DisconnectMcpRequest,
  DisconnectMcpResponse,
  McpServer,
  MessageMcpRequest,
  MessageMcpResponse,
} from "@agentclientprotocol/sdk";

import type {
  ApplicationTool,
  ApplicationToolResult,
  JsonObject,
  JsonValue,
  McpContent,
  SingleMcpServerOptions,
} from "./types.js";

const ACTION_ID_META_KEY = "agent-connect/actionId";
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

interface ConnectionState {
  readonly id: string;
  initialized: boolean;
}

export class McpOverAcpError extends Error {
  readonly code: number;
  readonly data: JsonValue | undefined;

  constructor(code: number, message: string, data?: JsonValue) {
    super(message);
    this.name = "McpOverAcpError";
    this.code = code;
    this.data = data;
  }
}

export function defineTool<Arguments extends JsonObject>(
  tool: ApplicationTool<Arguments>,
): ApplicationTool<Arguments> {
  return tool;
}

/**
 * A deliberately narrow application-owned MCP server transported through ACP.
 *
 * It supports one logical connection and a fixed tool set. Draft ACP transport
 * details are isolated here so the application-facing tool API can survive
 * protocol changes.
 */
export class SingleMcpServer {
  readonly descriptor: McpServer;

  private readonly name: string;
  private readonly serverId: string;
  private readonly version: string;
  private readonly instructions: string | undefined;
  private readonly tools: ReadonlyMap<string, ApplicationTool>;
  private readonly createConnectionId: () => string;
  private connection: ConnectionState | undefined;

  constructor(options: SingleMcpServerOptions) {
    assertNonEmpty(options.serverId, "serverId");
    assertNonEmpty(options.name, "name");
    assertNonEmpty(options.version, "version");

    const tools = new Map<string, ApplicationTool>();
    for (const tool of options.tools) {
      assertNonEmpty(tool.name, "tool name");
      if (tools.has(tool.name)) {
        throw new TypeError(`Duplicate application tool: ${tool.name}`);
      }
      tools.set(tool.name, tool);
    }

    this.name = options.name;
    this.serverId = options.serverId;
    this.version = options.version;
    this.instructions = options.instructions;
    this.tools = tools;
    this.createConnectionId = options.createConnectionId ?? defaultConnectionId;
    this.descriptor = {
      type: "acp",
      name: options.name,
      serverId: options.serverId,
    };
  }

  connect = (request: ConnectMcpRequest): ConnectMcpResponse => {
    if (request.serverId !== this.serverId) {
      throw new McpOverAcpError(
        INVALID_PARAMS,
        `Unknown MCP server: ${request.serverId}`,
      );
    }
    if (this.connection) {
      throw new McpOverAcpError(
        INVALID_REQUEST,
        "This MCP server already has an active connection",
      );
    }

    const connectionId = this.createConnectionId();
    assertNonEmpty(connectionId, "connectionId");
    this.connection = { id: connectionId, initialized: false };
    return { connectionId };
  };

  disconnect = (request: DisconnectMcpRequest): DisconnectMcpResponse => {
    this.requireConnection(request.connectionId);
    this.connection = undefined;
    return {};
  };

  message = async (request: MessageMcpRequest): Promise<MessageMcpResponse> => {
    const connection = this.requireConnection(request.connectionId);

    switch (request.method) {
      case "initialize":
        return this.initialize(connection, request.params);
      case "notifications/initialized":
        this.requireInitialized(connection);
        return {};
      case "ping":
        return {};
      case "tools/list":
        this.requireInitialized(connection);
        return this.listTools();
      case "tools/call":
        this.requireInitialized(connection);
        return this.callTool(connection, request.params, request._meta ?? null);
      default:
        throw new McpOverAcpError(
          METHOD_NOT_FOUND,
          `Unsupported MCP method: ${request.method}`,
        );
    }
  };

  private initialize(
    connection: ConnectionState,
    params: Record<string, unknown> | null | undefined,
  ): JsonObject {
    const protocolVersion = params?.["protocolVersion"];
    if (typeof protocolVersion !== "string" || protocolVersion.length === 0) {
      throw new McpOverAcpError(
        INVALID_PARAMS,
        "MCP initialize requires protocolVersion",
      );
    }

    connection.initialized = true;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.name, version: this.version },
      ...(this.instructions ? { instructions: this.instructions } : {}),
    };
  }

  private listTools(): JsonObject {
    return {
      tools: Array.from(this.tools.values(), (tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  }

  private async callTool(
    connection: ConnectionState,
    params: Record<string, unknown> | null | undefined,
    meta: Readonly<Record<string, unknown>> | null,
  ): Promise<JsonObject> {
    const name = params?.["name"];
    const arguments_ = params?.["arguments"];
    if (typeof name !== "string" || name.length === 0) {
      throw new McpOverAcpError(
        INVALID_PARAMS,
        "MCP tools/call requires a tool name",
      );
    }
    if (!isJsonObject(arguments_)) {
      throw new McpOverAcpError(
        INVALID_PARAMS,
        "MCP tools/call arguments must be an object",
      );
    }

    const tool = this.tools.get(name);
    if (!tool) {
      throw new McpOverAcpError(INVALID_PARAMS, `Unknown tool: ${name}`);
    }

    try {
      const result = await tool.execute(arguments_, {
        connectionId: connection.id,
        toolName: name,
        meta,
        actionId: actionIdFromMeta(meta),
      });
      return normalizeToolResult(result);
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text:
              error instanceof Error ? error.message : "Tool execution failed",
          },
        ],
        isError: true,
      };
    }
  }

  private requireConnection(connectionId: string): ConnectionState {
    if (!this.connection || this.connection.id !== connectionId) {
      throw new McpOverAcpError(
        INVALID_PARAMS,
        `Unknown MCP connection: ${connectionId}`,
      );
    }
    return this.connection;
  }

  private requireInitialized(connection: ConnectionState): void {
    if (!connection.initialized) {
      throw new McpOverAcpError(
        INVALID_REQUEST,
        "MCP connection is not initialized",
      );
    }
  }
}

function defaultConnectionId(): string {
  return globalThis.crypto.randomUUID();
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
}

function actionIdFromMeta(
  meta: Readonly<Record<string, unknown>> | null,
): string | undefined {
  const value = meta?.[ACTION_ID_META_KEY];
  return typeof value === "string" ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolResult(
  result: ApplicationToolResult | string | void,
): JsonObject {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  if (!result) {
    return { content: [] };
  }

  const content: readonly McpContent[] = result.content;
  return {
    content,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent }),
  };
}

export const JSON_RPC_ERROR_CODES = {
  invalidRequest: INVALID_REQUEST,
  methodNotFound: METHOD_NOT_FOUND,
  invalidParams: INVALID_PARAMS,
  internalError: INTERNAL_ERROR,
} as const;
