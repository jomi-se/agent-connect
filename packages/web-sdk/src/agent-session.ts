import { Ajv, type ValidateFunction } from "ajv";

import type {
  AgentConnectErrorCode,
  AgentProvider,
  AgentSessionOptions,
  AgentTaskError,
  AgentTaskEvent,
  AgentTaskResult,
  AgentToolDefinition,
  ApplicationTool,
  ApplicationToolResult,
  JsonObject,
} from "./types.js";

interface ToolSnapshot {
  readonly definition: AgentToolDefinition;
  readonly execute: ApplicationTool["execute"];
  readonly validate: ValidateFunction;
}

export class AgentConnectError extends Error {
  readonly code: AgentConnectErrorCode;
  readonly status: number | undefined;
  /**
   * Where the person can resolve this themselves, when the gateway offers such
   * a page. Set for `session_capacity`, whose only real remedy is for the owner
   * to end a session; an application should offer this as a link rather than
   * asking the user to retry into a full gateway.
   */
  readonly manageUrl: string | undefined;

  constructor(
    code: AgentConnectErrorCode,
    message: string,
    options: {
      readonly status?: number;
      readonly cause?: unknown;
      readonly manageUrl?: string;
    } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "AgentConnectError";
    this.code = code;
    this.status = options.status;
    this.manageUrl = options.manageUrl;
  }
}

export class AgentSession {
  private readonly provider: AgentProvider;
  private readonly tools: ReadonlyMap<string, ToolSnapshot>;
  private readonly sessionId: string;
  private continuationToken: string | undefined;
  private initialTaskStarted = false;

  constructor(options: AgentSessionOptions) {
    if (options.tools.length === 0) {
      throw new TypeError(
        "AgentSession requires at least one application tool",
      );
    }
    this.provider = options.provider;
    // Tool authorization is fixed for the lifetime of an application session.
    // Clone and compile it once so later caller mutation cannot change the
    // browser-side contract underneath the gateway's approved snapshot.
    this.tools = snapshotTools(options.tools);
    this.sessionId =
      options.createSessionId?.() ??
      `agent-session-${globalThis.crypto.randomUUID()}`;
  }

  async *streamTask(prompt: string): AsyncGenerator<AgentTaskEvent> {
    requirePrompt(prompt);
    if (this.initialTaskStarted) {
      throw new AgentConnectError(
        "protocol_error",
        "This agent session already started; continue the completed task or create a new session",
      );
    }
    this.initialTaskStarted = true;
    yield* this.stream(prompt, undefined);
  }

  async *streamContinuation(prompt: string): AsyncGenerator<AgentTaskEvent> {
    const checkpoint = this.continuationToken;
    if (!checkpoint) {
      throw new AgentConnectError(
        "continuation_unavailable",
        "No successfully completed task is available to continue",
      );
    }
    yield* this.stream(prompt, checkpoint);
  }

  private async *stream(
    prompt: string,
    continuationToken: string | undefined,
  ): AsyncGenerator<AgentTaskEvent> {
    requirePrompt(prompt);

    const completedActions = new Set<string>();
    let text = "";
    let terminal = false;

    yield { type: "task.started" };

    for await (const event of this.provider.streamTask({
      prompt,
      tools: Array.from(this.tools.values(), (tool) => tool.definition),
      ...(continuationToken ? { continuationToken } : {}),
    })) {
      // Once another turn is admitted, an older checkpoint is no longer a safe
      // branch point. The clock starts at admission, not at the attempt: a
      // request the gateway refused before admitting anything — a busy
      // session, a network failure — leaves the previous turn as the head, and
      // discarding the checkpoint there would strand the application with a
      // session it can no longer continue. A new checkpoint is published only
      // after a successful completion.
      this.continuationToken = undefined;
      switch (event.type) {
        case "text.delta":
          text += event.delta;
          yield event;
          break;
        case "tool.requested": {
          if (completedActions.has(event.actionId)) {
            break;
          }
          completedActions.add(event.actionId);
          const tool = this.tools.get(event.name);
          const arguments_ = asJsonObject(event.arguments);
          if (!tool) {
            const error = taskError(
              "unknown_tool",
              `The agent requested an unknown application tool: ${event.name}`,
            );
            await this.provider.submitToolResult(
              event.requestToken,
              serializeToolError(error),
            );
            yield toolCompleted(event.actionId, event.name, error);
            break;
          }
          if (!arguments_ || !tool.validate(arguments_)) {
            const details = tool.validate.errors
              ?.map(
                (error) =>
                  `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
              )
              .join("; ");
            const error = taskError(
              "invalid_tool_arguments",
              `Invalid arguments for ${event.name}${details ? `: ${details}` : ""}`,
            );
            await this.provider.submitToolResult(
              event.requestToken,
              serializeToolError(error),
            );
            yield toolCompleted(event.actionId, event.name, error);
            break;
          }

          yield {
            type: "tool.requested",
            actionId: event.actionId,
            name: event.name,
            arguments: arguments_,
          };

          try {
            const result = await tool.execute(arguments_, {
              connectionId: this.sessionId,
              toolName: event.name,
              meta: null,
              actionId: event.actionId,
            });
            await this.provider.submitToolResult(
              event.requestToken,
              serializeToolResult(result),
            );
            yield {
              type: "tool.completed",
              actionId: event.actionId,
              name: event.name,
              isError: false,
            };
          } catch (cause) {
            const error = taskError(
              "tool_execution_failed",
              cause instanceof Error
                ? cause.message
                : "Application tool execution failed",
            );
            await this.provider.submitToolResult(
              event.requestToken,
              serializeToolError(error),
            );
            yield toolCompleted(event.actionId, event.name, error);
          }
          break;
        }
        case "task.completed":
          terminal = true;
          this.continuationToken = event.continuationToken;
          yield { type: "task.completed", text };
          break;
        case "task.failed":
          terminal = true;
          yield {
            type: "task.failed",
            error: taskError("protocol_error", event.message),
          };
          break;
        case "task.cancelled":
          terminal = true;
          yield event;
          break;
      }
      if (terminal) {
        return;
      }
    }

    throw new AgentConnectError(
      "protocol_error",
      "Agent provider stream ended without a terminal event",
    );
  }

  async runTask(prompt: string): Promise<AgentTaskResult> {
    return this.collect(this.streamTask(prompt));
  }

  async continueTask(prompt: string): Promise<AgentTaskResult> {
    return this.collect(this.streamContinuation(prompt));
  }

  private async collect(
    stream: AsyncIterable<AgentTaskEvent>,
  ): Promise<AgentTaskResult> {
    let text = "";
    for await (const event of stream) {
      if (event.type === "task.completed") {
        text = event.text;
      } else if (event.type === "task.failed") {
        throw new AgentConnectError(event.error.code, event.error.message);
      } else if (event.type === "task.cancelled") {
        throw new AgentConnectError(
          "protocol_error",
          "Agent task was cancelled",
        );
      }
    }
    return { text };
  }

  cancel(): Promise<void> {
    return this.provider.cancel();
  }
}

function requirePrompt(prompt: string): void {
  if (prompt.trim().length === 0) {
    throw new TypeError("Task prompt must not be empty");
  }
}

function snapshotTools(
  tools: readonly ApplicationTool[],
): ReadonlyMap<string, ToolSnapshot> {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const snapshots = new Map<string, ToolSnapshot>();
  for (const tool of tools) {
    if (tool.name.trim().length === 0) {
      throw new TypeError("Application tool name must not be empty");
    }
    if (snapshots.has(tool.name)) {
      throw new TypeError(`Duplicate application tool: ${tool.name}`);
    }
    const inputSchema = cloneJsonObject(tool.inputSchema);
    snapshots.set(tool.name, {
      definition: {
        name: tool.name,
        description: tool.description,
        inputSchema,
      },
      execute: tool.execute.bind(tool),
      validate: ajv.compile(inputSchema),
    });
  }
  return snapshots;
}

function cloneJsonObject<T extends JsonObject>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function serializeToolResult(
  result: ApplicationToolResult | string | void,
): string {
  if (typeof result === "string") {
    return result;
  }
  if (result === undefined) {
    return "";
  }
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  const text = result.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
  return text || JSON.stringify(result);
}

function taskError(
  code: AgentConnectErrorCode,
  message: string,
): AgentTaskError {
  return { code, message };
}

function serializeToolError(error: AgentTaskError): string {
  return JSON.stringify({ error: error.message, code: error.code });
}

function toolCompleted(
  actionId: string,
  name: string,
  error: AgentTaskError,
): AgentTaskEvent {
  return { type: "tool.completed", actionId, name, isError: true, error };
}
