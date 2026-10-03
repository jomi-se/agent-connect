import type { Stream } from "@agentclientprotocol/sdk";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface JsonSchema extends JsonObject {
  readonly type?: string;
  readonly properties?: JsonObject;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
}

/** @experimental Unstable MCP content representation. */
export type McpContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    };

export interface ApplicationToolResult {
  readonly content: readonly McpContent[];
  readonly isError?: boolean;
  readonly structuredContent?: JsonObject;
}

export interface ApplicationToolContext {
  /** Cooperative cancellation; handlers remain responsible for their side effects. */
  readonly signal?: AbortSignal;
  readonly connectionId: string;
  readonly toolName: string;
  readonly meta: Readonly<Record<string, unknown>> | null;
  readonly actionId: string | undefined;
}

export interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface AcpTaskRequest {
  readonly prompt: string;
  readonly tools: readonly AgentToolDefinition[];
  /** Opaque provider checkpoint for an explicit completed-task follow-up. */
  readonly continuationToken?: string;
}

/** @experimental ACP progress additions are unstable. */
export interface AcpPlanEntry {
  readonly content: string;
  readonly priority: "high" | "medium" | "low";
  readonly status: "pending" | "in_progress" | "completed";
}
/** @experimental ACP native-tool progress; distinct from application execution. */
export interface AcpToolUpdate {
  readonly type: "tool.updated";
  readonly toolCallId: string;
  readonly title?: string;
  readonly status?: "pending" | "in_progress" | "completed" | "failed";
  readonly input?: unknown;
  readonly output?: unknown;
  readonly content?: readonly unknown[];
}
export type AcpTaskEvent =
  | { readonly type: "task.admitted" }
  | { readonly type: "text.delta"; readonly delta: string }
  | { readonly type: "thought.delta"; readonly delta: string }
  | { readonly type: "plan.updated"; readonly entries: readonly AcpPlanEntry[] }
  | AcpToolUpdate
  | {
      readonly type: "tool.requested";
      readonly requestToken: string;
      /** Cooperative interruption of a held application handler. */
      readonly signal?: AbortSignal;
      readonly actionId: string;
      readonly name: string;
      readonly arguments: unknown;
    }
  | { readonly type: "task.completed"; readonly continuationToken?: string }
  | {
      readonly type: "task.failed";
      /** Stable failure category when the provider can classify it. */
      readonly code?: AgentConnectErrorCode;
      readonly message: string;
    }
  | { readonly type: "task.cancelled" };

export interface AcpTaskSource {
  streamTask(request: AcpTaskRequest): AsyncIterable<AcpTaskEvent>;
  submitToolResult(
    requestToken: string,
    output: string,
    /** Optional original result for providers that retain structured content. */
    applicationResult?: ApplicationToolResult,
  ): Promise<void>;
  cancel(): Promise<void>;
}

export type AgentConnectErrorCode =
  | "protocol_error"
  | "frame_too_large"
  | "authorization_denied"
  | "invalid_app_grant"
  | "session_capacity"
  | "session_expired"
  | "session_superseded"
  | "task_interrupted"
  | "unknown_tool"
  | "invalid_tool_arguments"
  | "tool_execution_failed"
  | "continuation_unavailable"
  | "task_busy"
  | "agent_execution_failed"
  | "webmcp_unavailable"
  | "webmcp_snapshot_invalidated";

export interface AcpExecutionError {
  readonly code: AgentConnectErrorCode;
  readonly message: string;
}

export type AcpExecutionEvent =
  | { readonly type: "task.started" }
  | { readonly type: "text.delta"; readonly delta: string }
  | { readonly type: "thought.delta"; readonly delta: string }
  | { readonly type: "plan.updated"; readonly entries: readonly AcpPlanEntry[] }
  | AcpToolUpdate
  | {
      readonly type: "tool.requested";
      readonly actionId: string;
      readonly name: string;
      readonly arguments: JsonObject;
    }
  | {
      readonly type: "tool.completed";
      readonly actionId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly error?: AcpExecutionError;
    }
  | { readonly type: "task.completed"; readonly text: string }
  | { readonly type: "task.failed"; readonly error: AcpExecutionError }
  | { readonly type: "task.cancelled" };

export interface AcpToolExecutorOptions {
  readonly provider: AcpTaskSource;
  readonly tools: readonly ApplicationTool[];
  readonly createSessionId?: () => string;
}

export type ApplicationToolHandler<Arguments extends JsonObject = JsonObject> =
  (
    arguments_: Arguments,
    context: ApplicationToolContext,
  ) =>
    | ApplicationToolResult
    | string
    | void
    | Promise<ApplicationToolResult | string | void>;

export interface ApplicationTool<Arguments extends JsonObject = JsonObject> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  execute(
    arguments_: Arguments,
    context: ApplicationToolContext,
  ):
    | ApplicationToolResult
    | string
    | void
    | Promise<ApplicationToolResult | string | void>;
}

/** @experimental Unstable MCP-over-ACP server configuration. */
export interface SingleMcpServerOptions {
  readonly serverId: string;
  readonly name: string;
  readonly version: string;
  readonly instructions?: string;
  readonly tools: readonly ApplicationTool[];
  readonly createConnectionId?: () => string;
}

/** @experimental Unstable ACP WebSocket stream options. */
export interface BrowserAcpStreamOptions {
  readonly protocols?: readonly string[];
  readonly cookies?: "include" | "omit";
}

/** @experimental Unstable ACP stream alias. */
export type BrowserAcpStream = Stream;
