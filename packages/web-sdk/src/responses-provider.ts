import { AgentConnectError } from "./agent-session.js";
import type {
  AgentProvider,
  AgentProviderEvent,
  AgentProviderTaskRequest,
  ResponsesProviderOptions,
} from "./types.js";

const MODEL = "agent-connect/default";

interface PendingOutput {
  readonly callId: string;
  readonly output: string;
}

/**
 * Drives the gateway's Open Responses endpoint. One `runTask()` becomes a chain
 * of response segments: a segment ends when the agent asks the application for
 * a function result, and the next segment is created with
 * `previous_response_id` once the browser has produced it. The chaining is
 * internal, so `AgentSession` sees the same provider event stream as before.
 */
export class ResponsesProvider implements AgentProvider {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly credentials: RequestCredentials;
  private controller: AbortController | undefined;
  private resolveOutput:
    ((output: PendingOutput | undefined) => void) | undefined;
  private pendingOutput: PendingOutput | undefined;
  private latestResponseId: string | undefined;
  private cancelRequested = false;

  constructor(options: ResponsesProviderOptions) {
    if (options.baseUrl.trim().length === 0) {
      throw new TypeError("Agent Connect baseUrl must not be empty");
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImplementation =
      options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = options.headers ?? {};
    this.credentials = options.credentials ?? "same-origin";
  }

  /** The most recent response id, for recovery through the control extensions. */
  get responseId(): string | undefined {
    return this.latestResponseId;
  }

  async *streamTask(
    request: AgentProviderTaskRequest,
  ): AsyncGenerator<AgentProviderEvent> {
    if (this.controller) {
      throw new AgentConnectError(
        "protocol_error",
        "This provider already has an active task",
      );
    }
    const controller = new AbortController();
    this.controller = controller;
    this.cancelRequested = false;
    this.latestResponseId = undefined;
    this.resolveOutput = undefined;
    this.pendingOutput = undefined;

    try {
      let body: Record<string, unknown> = {
        model: MODEL,
        stream: true,
        input: request.prompt,
        ...(request.continuationToken
          ? { previous_response_id: request.continuationToken }
          : {
              tools: request.tools.map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              })),
            }),
      };
      for (;;) {
        const segment = yield* this.streamSegment(body, controller);
        if (segment.terminal) {
          if (
            segment.terminal.type === "task.completed" &&
            segment.responseId === ""
          ) {
            throw new AgentConnectError(
              "protocol_error",
              "The gateway completed a response without publishing its id",
            );
          }
          yield segment.terminal.type === "task.completed"
            ? {
                ...segment.terminal,
                continuationToken: segment.responseId,
              }
            : segment.terminal;
          return;
        }
        // The segment ended on a function call. Wait for the application's
        // output, then continue the same chain.
        const pending = await this.awaitOutput();
        if (!pending) {
          yield { type: "task.cancelled" };
          return;
        }
        body = {
          model: MODEL,
          stream: true,
          previous_response_id: segment.responseId,
          input: [
            {
              type: "function_call_output",
              call_id: pending.callId,
              output: pending.output,
            },
          ],
        };
      }
    } catch (cause) {
      if (this.cancelRequested && isAbortError(cause)) {
        yield { type: "task.cancelled" };
        return;
      }
      if (cause instanceof AgentConnectError) throw cause;
      throw new AgentConnectError(
        "http_error",
        "The Agent Connect response stream failed",
        { cause },
      );
    } finally {
      controller.abort();
      if (this.controller === controller) this.controller = undefined;
      this.resolveOutput = undefined;
    }
  }

  private async *streamSegment(
    body: Record<string, unknown>,
    controller: AbortController,
  ): AsyncGenerator<
    AgentProviderEvent,
    { responseId: string; terminal: AgentProviderEvent | undefined }
  > {
    const response = await this.fetchImplementation(
      `${this.baseUrl}/v1/responses`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...this.headers,
        },
        credentials: this.credentials,
        signal: controller.signal,
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) throw await responseError(response);
    if (!response.body) {
      throw new AgentConnectError(
        "protocol_error",
        "The gateway returned no response stream",
      );
    }

    let responseId = "";
    let sawCall = false;
    let errorMessage: string | undefined;
    for await (const event of parseSse(response.body)) {
      const type = event["type"];
      if (type === "response.created") {
        responseId = responseIdOf(event);
        this.latestResponseId = responseId;
        continue;
      }
      if (type === "response.output_text.delta") {
        const delta = event["delta"];
        if (typeof delta === "string") yield { type: "text.delta", delta };
        continue;
      }
      if (type === "response.output_item.done") {
        const call = functionCallOf(event);
        if (call) {
          sawCall = true;
          yield call;
        }
        continue;
      }
      if (type === "error") {
        errorMessage = messageOf(event["error"]);
        continue;
      }
      const terminal = terminalOf(event, sawCall, errorMessage);
      if (terminal) return { responseId, terminal: terminal.event };
    }
    throw new AgentConnectError(
      "protocol_error",
      "The response stream ended before a terminal event",
    );
  }

  /**
   * Records the application's output for the call the current segment
   * published. The output usually arrives while the generator is still
   * suspended on the `tool.requested` it just yielded, so it is buffered in a
   * one-slot mailbox and consumed when the chain continues.
   */
  async submitToolResult(requestToken: string, output: string): Promise<void> {
    if (this.pendingOutput) {
      throw new AgentConnectError(
        "protocol_error",
        "This response chain already has an unsent function output",
      );
    }
    const pending = { callId: requestToken, output };
    const resolve = this.resolveOutput;
    if (resolve) {
      this.resolveOutput = undefined;
      resolve(pending);
      return;
    }
    this.pendingOutput = pending;
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    const responseId = this.latestResponseId;
    const waiting = this.resolveOutput;
    this.resolveOutput = undefined;
    this.pendingOutput = undefined;
    if (responseId) {
      await this.fetchImplementation(
        `${this.baseUrl}/v1/agent-connect/responses/${encodeURIComponent(responseId)}/cancel`,
        {
          method: "POST",
          headers: this.headers,
          credentials: this.credentials,
        },
      ).catch(() => undefined);
    }
    // Release a chain parked on an unanswered call, which no HTTP request is
    // currently streaming and which an abort therefore cannot reach.
    if (waiting) this.wakeCancelled();
    this.controller?.abort();
  }

  private awaitOutput(): Promise<PendingOutput | undefined> {
    if (this.cancelRequested) return Promise.resolve(undefined);
    const buffered = this.pendingOutput;
    if (buffered) {
      this.pendingOutput = undefined;
      return Promise.resolve(buffered);
    }
    return new Promise<PendingOutput | undefined>((resolve) => {
      this.resolveOutput = resolve;
      this.wakeCancelled = () => resolve(undefined);
    });
  }

  private wakeCancelled: () => void = () => {};
}

async function responseError(response: Response): Promise<AgentConnectError> {
  const body = (await response.text()).slice(0, 500);
  let gatewayCode: string | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof (parsed as { error: { code?: unknown } }).error?.code === "string"
    ) {
      gatewayCode = (parsed as { error: { code: string } }).error.code;
    }
  } catch {
    // A non-JSON body keeps the generic code.
  }
  const code =
    response.status === 401
      ? "invalid_app_grant"
      : gatewayCode === "response_busy"
        ? "task_busy"
        : gatewayCode === "previous_response_not_continuable"
          ? "continuation_unavailable"
          : "http_error";
  return new AgentConnectError(
    code,
    `The gateway rejected the response request (${gatewayCode ?? "unknown"}): HTTP ${response.status}${body ? ` — ${body}` : ""}`,
    { status: response.status },
  );
}

/**
 * A completed segment ends the run only when it left no unresolved call: with
 * one outstanding, the chain continues in the next segment instead.
 */
function terminalOf(
  event: Record<string, unknown>,
  sawCall: boolean,
  errorMessage: string | undefined,
): { event: AgentProviderEvent | undefined } | undefined {
  switch (event["type"]) {
    case "response.completed":
      return { event: sawCall ? undefined : { type: "task.completed" } };
    case "response.failed":
      return {
        event: {
          type: "task.failed",
          message:
            errorMessage ??
            messageOf(errorOf(event["response"])) ??
            "The agent task failed",
        },
      };
    case "response.incomplete":
      return { event: { type: "task.cancelled" } };
    default:
      return undefined;
  }
}

function functionCallOf(
  event: Record<string, unknown>,
): AgentProviderEvent | undefined {
  const item = event["item"];
  if (!isRecord(item) || item["type"] !== "function_call") return undefined;
  const callId = item["call_id"];
  const name = item["name"];
  const args = item["arguments"];
  if (typeof callId !== "string" || typeof name !== "string") {
    throw new AgentConnectError(
      "protocol_error",
      "The gateway emitted a function call without a call_id and name",
    );
  }
  let parsed: unknown = {};
  if (typeof args === "string" && args.length > 0) {
    try {
      parsed = JSON.parse(args);
    } catch (cause) {
      throw new AgentConnectError(
        "protocol_error",
        "The gateway emitted malformed function call arguments",
        { cause },
      );
    }
  }
  return {
    type: "tool.requested",
    requestToken: callId,
    actionId: callId,
    name,
    arguments: parsed,
  };
}

function responseIdOf(event: Record<string, unknown>): string {
  const response = event["response"];
  return isRecord(response) && typeof response["id"] === "string"
    ? response["id"]
    : "";
}

function errorOf(value: unknown): unknown {
  return isRecord(value) ? value["error"] : undefined;
}

function messageOf(value: unknown): string | undefined {
  return isRecord(value) && typeof value["message"] === "string"
    ? value["message"]
    : undefined;
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
      }
      if (done) {
        const trailing = parseFrame(buffer);
        if (trailing) yield trailing;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): Record<string, unknown> | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (cause) {
    throw new AgentConnectError(
      "protocol_error",
      "The gateway emitted malformed JSON in a response stream",
      { cause },
    );
  }
  if (!isRecord(parsed) || typeof parsed["type"] !== "string") {
    throw new AgentConnectError(
      "protocol_error",
      "The gateway emitted a response event without a string type",
    );
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === "AbortError";
}
