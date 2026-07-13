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
