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

export interface AgentProviderTaskRequest {
  readonly prompt: string;
  readonly tools: readonly AgentToolDefinition[];
  /** Opaque provider checkpoint for an explicit completed-task follow-up. */
  readonly continuationToken?: string;
}

export type AgentProviderEvent =
  | { readonly type: "text.delta"; readonly delta: string }
  | {
      readonly type: "tool.requested";
      readonly requestToken: string;
      readonly actionId: string;
      readonly name: string;
      readonly arguments: unknown;
    }
  | { readonly type: "task.completed"; readonly continuationToken?: string }
  | { readonly type: "task.failed"; readonly message: string }
  | { readonly type: "task.cancelled" };

export interface AgentProvider {
  streamTask(
    request: AgentProviderTaskRequest,
  ): AsyncIterable<AgentProviderEvent>;
  submitToolResult(requestToken: string, output: string): Promise<void>;
  cancel(): Promise<void>;
}

export type AgentConnectErrorCode =
  | "http_error"
  | "protocol_error"
  | "runtime_identity_mismatch"
  | "authorization_denied"
  | "authorization_expired"
  | "invalid_app_grant"
  | "session_capacity"
  | "session_expired"
  | "unknown_tool"
  | "invalid_tool_arguments"
  | "tool_execution_failed"
  | "continuation_unavailable"
  | "task_busy";

export interface AgentTaskError {
  readonly code: AgentConnectErrorCode;
  readonly message: string;
}

export type AgentTaskEvent =
  | { readonly type: "task.started" }
  | { readonly type: "text.delta"; readonly delta: string }
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
      readonly error?: AgentTaskError;
    }
  | { readonly type: "task.completed"; readonly text: string }
  | { readonly type: "task.failed"; readonly error: AgentTaskError }
  | { readonly type: "task.cancelled" };

export interface AgentTaskResult {
  readonly text: string;
}

export interface AgentSessionOptions {
  readonly provider: AgentProvider;
  readonly tools: readonly ApplicationTool[];
  readonly createSessionId?: () => string;
}

export interface ResponsesProviderOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentials?: RequestCredentials;
}

export interface ConnectAgentOptions {
  readonly baseUrl: string;
  readonly appId: string;
  readonly tools: readonly ApplicationTool[];
  /**
   * Either the application grant, which always provisions a new independent
   * session, or a session capability from a previous connect, which reconnects
   * to that one session and nothing else. There is no credential that lets the
   * gateway pick a session on the caller's behalf.
   */
  readonly accessToken: string;
  /**
   * @deprecated An application grant already means "create a new session", so
   * this has no effect. Accepted for compatibility and due for removal.
   */
  readonly freshSession?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentials?: RequestCredentials;
}

export interface RuntimeCard {
  readonly version: 1;
  readonly runtimeId: string;
  readonly endpoint: string;
  readonly connectorPublicKey: JsonWebKey;
  readonly transportProfile: string;
  readonly authorizationServer: string;
}

export interface BeginAgentAuthorizationOptions {
  readonly runtimeCard: RuntimeCard;
  readonly appId: string;
  readonly redirectUri: string;
  readonly tools: readonly ApplicationTool[];
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentials?: RequestCredentials;
}

export interface AgentAuthorizationTransaction {
  readonly version: 1;
  readonly runtimeId: string;
  readonly appId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly requestId: string;
}

export interface AgentAuthorizationStart {
  readonly authorizeUrl: string;
  readonly expiresAt: string;
  readonly transaction: AgentAuthorizationTransaction;
}

export interface CompleteAgentAuthorizationOptions {
  readonly runtimeCard: RuntimeCard;
  readonly appId: string;
  readonly redirectUri: string;
  readonly transaction: AgentAuthorizationTransaction;
  readonly callbackUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentials?: RequestCredentials;
}

export interface RevokeAgentAuthorizationOptions {
  readonly baseUrl: string;
  readonly appId: string;
  readonly accessToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentials?: RequestCredentials;
}

export interface AgentAuthorizationGrant {
  readonly accessToken: string;
  readonly tokenType: "Bearer";
  readonly expiresAt: string;
  readonly grant: {
    readonly id: string;
    readonly origin: string;
    readonly appId: string;
    readonly scopes: readonly string[];
    readonly toolHash: string;
    readonly toolNames: readonly string[];
    readonly createdAt: string;
    readonly expiresAt: string;
  };
}

export interface AgentConnection {
  readonly session: import("./agent-session.js").AgentSession;
  /** Opaque Agent Connect id; never an underlying harness/provider id. */
  readonly sessionId: string;
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly toolHash: string;
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

export interface SingleMcpServerOptions {
  readonly serverId: string;
  readonly name: string;
  readonly version: string;
  readonly instructions?: string;
  readonly tools: readonly ApplicationTool[];
  readonly createConnectionId?: () => string;
}

export interface BrowserAcpStreamOptions {
  readonly protocols?: readonly string[];
  readonly cookies?: "include" | "omit";
}

export type BrowserAcpStream = Stream;
