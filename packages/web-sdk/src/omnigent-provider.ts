import { AgentConnectError } from "./agent-session.js";
import type {
  AgentProvider,
  AgentProviderEvent,
  AgentProviderTaskRequest,
  OmnigentProviderOptions,
} from "./types.js";

interface OmnigentEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export class OmnigentProvider implements AgentProvider {
  private readonly baseUrl: string;
  private readonly sessionId: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly credentials: RequestCredentials;
  private activeController: AbortController | undefined;
  private cancelRequested = false;

  constructor(options: OmnigentProviderOptions) {
    if (options.baseUrl.trim().length === 0) {
      throw new TypeError("Omnigent baseUrl must not be empty");
    }
    if (options.sessionId.trim().length === 0) {
      throw new TypeError("Omnigent sessionId must not be empty");
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.sessionId = options.sessionId;
    this.fetchImplementation =
      options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = options.headers ?? {};
    this.credentials = options.credentials ?? "same-origin";
  }

  async *streamTask(
    request: AgentProviderTaskRequest,
  ): AsyncGenerator<AgentProviderEvent> {
    if (this.activeController) {
      throw new AgentConnectError(
        "protocol_error",
        "This Omnigent provider already has an active task",
      );
    }

    const controller = new AbortController();
    this.activeController = controller;
    this.cancelRequested = false;
    try {
      const response = await this.fetchImplementation(
        `${this.baseUrl}/v1/sessions/${encodeURIComponent(this.sessionId)}/stream`,
        {
          method: "GET",
          headers: { Accept: "text/event-stream", ...this.headers },
          credentials: this.credentials,
          signal: controller.signal,
        },
      );
      await requireOk(response, "open Omnigent session stream");
      if (!response.body) {
        throw new AgentConnectError(
          "protocol_error",
          "Omnigent session stream response had no body",
        );
      }

      await this.postEvent({
        type: "message",
        data: {
          role: "user",
          content: [{ type: "input_text", text: request.prompt }],
        },
        tools: request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      });

      for await (const event of parseOmnigentSse(response.body)) {
        const mapped = mapOmnigentEvent(event);
        if (mapped) {
          yield mapped;
          if (
            mapped.type === "task.completed" ||
            mapped.type === "task.failed" ||
            mapped.type === "task.cancelled"
          ) {
            return;
          }
        }
      }
    } catch (cause) {
      if (this.cancelRequested && isAbortError(cause)) {
        yield { type: "task.cancelled" };
        return;
      }
      if (cause instanceof AgentConnectError) {
        throw cause;
      }
      throw new AgentConnectError(
        "http_error",
        "The Omnigent session connection failed",
        { cause },
      );
    } finally {
      controller.abort();
      if (this.activeController === controller) {
        this.activeController = undefined;
      }
    }
  }

  async submitToolResult(requestToken: string, output: string): Promise<void> {
    await this.postEvent({
      type: "function_call_output",
      data: { call_id: requestToken, output },
    });
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    await this.postEvent({ type: "interrupt", data: {} });
    this.activeController?.abort();
  }

  private async postEvent(event: unknown): Promise<void> {
    const response = await this.fetchImplementation(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(this.sessionId)}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        credentials: this.credentials,
        body: JSON.stringify(event),
      },
    );
    await requireOk(response, "post Omnigent session event");
  }
}

async function requireOk(response: Response, operation: string): Promise<void> {
  if (response.ok) {
    return;
  }
  const body = (await response.text()).slice(0, 500);
  throw new AgentConnectError(
    "http_error",
    `Failed to ${operation}: HTTP ${response.status}${body ? ` — ${body}` : ""}`,
    { status: response.status },
  );
}

async function* parseOmnigentSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OmnigentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const parsed = parseSseFrame(frame);
        if (parsed) {
          yield parsed;
        }
      }
      if (done) {
        if (buffer.trim()) {
          const parsed = parseSseFrame(buffer);
          if (parsed) {
            yield parsed;
          }
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string): OmnigentEvent | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (cause) {
    throw new AgentConnectError(
      "protocol_error",
      "Omnigent emitted malformed JSON in its session stream",
      { cause },
    );
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new AgentConnectError(
      "protocol_error",
      "Omnigent emitted a session event without a string type",
    );
  }
  return parsed as OmnigentEvent;
}

function mapOmnigentEvent(
  event: OmnigentEvent,
): AgentProviderEvent | undefined {
  switch (event.type) {
    case "response.output_text.delta":
      if (typeof event.delta !== "string") {
        throw malformedEvent(event.type, "delta");
      }
      return { type: "text.delta", delta: event.delta };
    case "response.output_item.done": {
      const item = event.item;
      if (
        !isRecord(item) ||
        item.type !== "function_call" ||
        item.status !== "action_required"
      ) {
        return undefined;
      }
      if (
        typeof item.call_id !== "string" ||
        typeof item.name !== "string" ||
        !(typeof item.arguments === "string" || isRecord(item.arguments))
      ) {
        throw malformedEvent(event.type, "item");
      }
      let arguments_: unknown = item.arguments;
      if (typeof arguments_ === "string") {
        try {
          arguments_ = JSON.parse(arguments_);
        } catch (cause) {
          throw new AgentConnectError(
            "protocol_error",
            "Omnigent emitted malformed tool-call arguments",
            { cause },
          );
        }
      }
      return {
        type: "tool.requested",
        requestToken: item.call_id,
        actionId: item.call_id,
        name: item.name,
        arguments: arguments_,
      };
    }
    case "response.completed":
      return { type: "task.completed" };
    case "response.failed":
    case "response.incomplete":
      return { type: "task.failed", message: terminalMessage(event) };
    case "response.cancelled":
    case "session.interrupted":
      return { type: "task.cancelled" };
    default:
      return undefined;
  }
}

function terminalMessage(event: OmnigentEvent): string {
  const response = event.response;
  if (
    isRecord(response) &&
    isRecord(response.error) &&
    typeof response.error.message === "string"
  ) {
    return response.error.message;
  }
  return `Agent task ended with ${event.type}`;
}

function malformedEvent(type: string, field: string): AgentConnectError {
  return new AgentConnectError(
    "protocol_error",
    `Omnigent ${type} event had an invalid ${field} field`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === "AbortError";
}
