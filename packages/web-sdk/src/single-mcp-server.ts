import type { McpServer } from "@agentclientprotocol/sdk";

import type {
  ApplicationTool,
  ApplicationToolResult,
  JsonObject,
  JsonValue,
  McpContent,
  SingleMcpServerOptions,
} from "./types.js";

/** The MCP revision the MCP-over-ACP binding carries. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
const ACTION_ID_META_KEY = "agent-connect/actionId";
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** Outer binding error: no server is registered under the requested ID. */
const SERVER_UNAVAILABLE = -33001;

/** @experimental One `mcp/message` request of the MCP-over-ACP binding. */
export interface McpMessageRequest {
  readonly serverId: string;
  readonly requestId: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown> | null;
  readonly _meta?: Record<string, unknown> | null;
}

/** @experimental The response carrier: an inner MCP result or error, never both. */
export type McpMessageResponse =
  | { readonly result: JsonObject }
  | {
      readonly error: {
        readonly code: number;
        readonly message: string;
        readonly data?: JsonValue;
      };
    };

/**
 * @experimental An inner MCP error. It travels inside a successful
 * `mcp/message` response, so the agent's MCP client sees an ordinary MCP error.
 */
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

/**
 * A failure of the binding itself, answered as an ACP error rather than an
 * inner MCP one.
 */
export class McpBindingError extends Error {
  readonly code: number;
  readonly data: JsonValue | undefined;

  constructor(code: number, message: string, data?: JsonValue) {
    super(message);
    this.name = "McpBindingError";
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
 * @experimental Unstable MCP-over-ACP implementation.
 * A deliberately narrow application-owned MCP server transported through ACP,
 * on MCP 2026-07-28: stateless requests routed by server ID, discovery through
 * `server/discover`, and a fixed tool set. Transport details stay here so the
 * application-facing tool API can survive protocol changes.
 */
export class SingleMcpServer {
  readonly descriptor: McpServer;

  private readonly name: string;
  readonly serverId: string;
  private readonly version: string;
  private readonly instructions: string | undefined;
  private readonly tools: ReadonlyMap<string, ApplicationTool>;

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
    this.descriptor = {
      type: "acp",
      name: options.name,
      serverId: options.serverId,
    };
  }

  message = async (request: McpMessageRequest): Promise<McpMessageResponse> => {
    if (request.serverId !== this.serverId) {
      throw new McpBindingError(
        SERVER_UNAVAILABLE,
        "MCP server registration unavailable",
        { serverId: request.serverId },
      );
    }
    try {
      return { result: await this.dispatch(request) };
    } catch (error) {
      if (!(error instanceof McpOverAcpError)) throw error;
      return {
        error: {
          code: error.code,
          message: error.message,
          ...(error.data === undefined ? {} : { data: error.data }),
        },
      };
    }
  };

  private async dispatch(request: McpMessageRequest): Promise<JsonObject> {
    const meta = request.params?.["_meta"];
    const version = isJsonObject(meta)
      ? meta[PROTOCOL_VERSION_META]
      : undefined;
    if (typeof version !== "string") {
      throw new McpOverAcpError(
        INVALID_PARAMS,
        `Invalid params: missing ${PROTOCOL_VERSION_META} in params._meta`,
      );
    }
    if (version !== MCP_PROTOCOL_VERSION) {
      throw new McpOverAcpError(
        UNSUPPORTED_PROTOCOL_VERSION,
        "Unsupported protocol version",
        { supported: [MCP_PROTOCOL_VERSION], requested: version },
      );
    }
    if (!isJsonObject(meta) || !isJsonObject(meta[CLIENT_CAPABILITIES_META])) {
      throw new McpOverAcpError(
        INVALID_PARAMS,
        `Invalid params: missing ${CLIENT_CAPABILITIES_META} in params._meta`,
      );
    }

    switch (request.method) {
      case "server/discover":
        // Discovery results are cacheable since MCP's caching fields arrived;
        // this server's tools belong to one session, so nothing is shared.
        return {
          resultType: "complete",
          supportedVersions: [MCP_PROTOCOL_VERSION],
          ttlMs: 0,
          cacheScope: "private",
          capabilities: { tools: { listChanged: false } },
          ...(this.instructions ? { instructions: this.instructions } : {}),
          _meta: {
            [SERVER_INFO_META]: { name: this.name, version: this.version },
          },
        };
      case "ping":
        return {};
      case "tools/list":
        return this.listTools();
      case "tools/call":
        return this.callTool(request, toolMeta(request));
      default:
        throw new McpOverAcpError(
          METHOD_NOT_FOUND,
          `Method not found: ${request.method}`,
        );
    }
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
    request: McpMessageRequest,
    meta: Readonly<Record<string, unknown>> | null,
  ): Promise<JsonObject> {
    const name = request.params?.["name"];
    const arguments_ = request.params?.["arguments"];
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
        requestId: String(request.requestId),
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

function toolMeta(
  request: McpMessageRequest,
): Readonly<Record<string, unknown>> {
  const inner = isJsonObject(request.params?.["_meta"])
    ? request.params["_meta"]
    : {};
  const outer = request._meta ?? {};
  const meta: Record<string, unknown> = { ...inner, ...outer };
  // The binding's own request metadata is not for tools.
  for (const key of Object.keys(meta))
    if (key.startsWith("io.modelcontextprotocol/")) delete meta[key];
  // MCP progress belongs to the inner tools/call request. Gateway action IDs
  // belong to the outer ACP envelope; neither namespace may replace the other.
  delete meta["progressToken"];
  if (Object.hasOwn(inner, "progressToken"))
    meta["progressToken"] = inner["progressToken"];
  delete meta[ACTION_ID_META_KEY];
  if (typeof outer[ACTION_ID_META_KEY] === "string")
    meta[ACTION_ID_META_KEY] = outer[ACTION_ID_META_KEY];
  return meta;
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
