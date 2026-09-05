import type { GatewayToolDefinition } from "../tool-snapshot.js";
import type { ParsedResponseRequest } from "./profile.js";
import { ResponseApiError } from "./errors.js";
import {
  buildResponseResource,
  projectTools,
  type ResponseOutputItem,
  type ResponseStreamEvent,
  type ResponseResource,
} from "./protocol.js";

export interface OpenClawResponsesOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly agentId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** Private HTTP policy boundary, not a second agent runtime/event protocol. */
export class OpenClawResponses {
  private readonly fetch: typeof globalThis.fetch;
  private readonly endpoint: string;
  constructor(private readonly options: OpenClawResponsesOptions) {
    const url = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new TypeError("invalid OpenClaw base URL");
    if (!options.token || !/^[a-zA-Z0-9_-]+$/.test(options.agentId))
      throw new TypeError("OpenClaw token and explicit agent ID are required");
    this.endpoint = options.baseUrl.replace(/\/$/, "") + "/v1/responses";
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  async create(
    sessionKey: string,
    tools: readonly GatewayToolDefinition[],
    request: ParsedResponseRequest,
    signal: AbortSignal,
  ): Promise<AsyncGenerator<ResponseStreamEvent>> {
    if (
      !sessionKey.startsWith(
        "agent:" + this.options.agentId + ":openresponses:",
      )
    )
      throw new ResponseApiError(
        "previous_response_not_continuable",
        "the configured upstream agent changed; create a new application session",
      );
    const combined = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
    ]);
    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: combined,
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: "Bearer " + this.options.token,
          "x-openclaw-agent-id": this.options.agentId,
          "x-openclaw-session-key": sessionKey,
        },
        body: JSON.stringify({
          model: "openclaw",
          stream: true,
          tools: projectTools(tools),
          tool_choice: "auto",
          ...(request.kind !== "initial"
            ? { previous_response_id: request.previousResponseId }
            : {}),
          input:
            request.kind === "continuation"
              ? [
                  {
                    type: "function_call_output",
                    call_id: request.callId,
                    output: request.output,
                  },
                ]
              : request.prompt,
        }),
      });
    } catch {
      throw new ResponseApiError(
        "backend_unavailable",
        "OpenClaw request failed; acceptance may be uncertain",
      );
    }
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      await response.body?.cancel();
      throw new ResponseApiError(
        "backend_unavailable",
        "OpenClaw did not accept the bounded Responses request",
      );
    }
    return this.events(response.body, tools, request);
  }
  private async *events(
    body: ReadableStream<Uint8Array>,
    tools: readonly GatewayToolDefinition[],
    request: ParsedResponseRequest,
  ): AsyncGenerator<ResponseStreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let total = 0;
    let sequence = -1;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > 8 * 1024 * 1024) throw invalid();
        buffer = (
          buffer + decoder.decode(chunk.value, { stream: true })
        ).replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          if (data === "[DONE]") return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw invalid();
          }
          if (record(parsed) && parsed.sequence_number === undefined)
            parsed = { ...parsed, sequence_number: sequence + 1 };
          const event = normalizeEvent(parsed, tools, request);
          if (event.sequence_number <= sequence) throw invalid();
          sequence = event.sequence_number;
          yield event;
        }
      }
      if (buffer.trim()) throw invalid();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function index(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
function invalid() {
  return new ResponseApiError(
    "backend_protocol_error",
    "OpenClaw returned an invalid bounded Responses event",
  );
}
function item(value: unknown): ResponseOutputItem {
  if (!record(value) || !id(value.id)) throw invalid();
  if (
    value.status !== undefined &&
    !["in_progress", "completed", "incomplete"].includes(String(value.status))
  )
    throw invalid();
  if (value.type === "function_call") {
    if (
      !id(value.call_id) ||
      value.call_id.length > 64 ||
      typeof value.name !== "string" ||
      typeof value.arguments !== "string" ||
      value.arguments.length > 128 * 1024
    )
      throw invalid();
    try {
      const args: unknown = JSON.parse(value.arguments);
      if (!record(args)) throw invalid();
    } catch {
      throw invalid();
    }
    return {
      type: "function_call",
      id: value.id,
      call_id: value.call_id,
      name: value.name,
      arguments: value.arguments,
      status:
        value.status === "in_progress"
          ? "in_progress"
          : value.status === "incomplete"
            ? "incomplete"
            : "completed",
    };
  }
  if (
    value.type !== "message" ||
    value.role !== "assistant" ||
    !Array.isArray(value.content)
  )
    throw invalid();
  const content = value.content.map((part: unknown) => {
    if (
      !record(part) ||
      part.type !== "output_text" ||
      typeof part.text !== "string"
    )
      throw invalid();
    return { type: "output_text" as const, text: part.text, annotations: [] };
  });
  return {
    type: "message",
    id: value.id,
    role: "assistant",
    status:
      value.status === "in_progress"
        ? "in_progress"
        : value.status === "incomplete"
          ? "incomplete"
          : "completed",
    content,
  };
}
function resource(
  value: unknown,
  tools: readonly GatewayToolDefinition[],
  request: ParsedResponseRequest,
): ResponseResource {
  if (
    !record(value) ||
    !id(value.id) ||
    value.object !== "response" ||
    typeof value.created_at !== "number" ||
    !Number.isFinite(value.created_at) ||
    !["in_progress", "completed", "failed", "incomplete", "cancelled"].includes(
      String(value.status),
    ) ||
    !Array.isArray(value.output)
  )
    throw invalid();
  return buildResponseResource({
    id: value.id,
    createdAt: value.created_at,
    completedAt:
      value.status === "in_progress"
        ? null
        : typeof value.completed_at === "number"
          ? value.completed_at
          : value.created_at,
    status: value.status as ResponseResource["status"],
    previousResponseId:
      request.kind === "initial" ? null : request.previousResponseId,
    output: value.output.map(item),
    error:
      value.status === "failed"
        ? { code: "backend_unavailable", message: "OpenClaw response failed" }
        : null,
    tools: projectTools(tools),
  });
}
function normalizeEvent(
  value: unknown,
  tools: readonly GatewayToolDefinition[],
  request: ParsedResponseRequest,
): ResponseStreamEvent {
  if (
    !record(value) ||
    typeof value.type !== "string" ||
    !index(value.sequence_number)
  )
    throw invalid();
  const base = { sequence_number: value.sequence_number };
  switch (value.type) {
    case "response.created":
    case "response.in_progress":
    case "response.completed":
    case "response.failed":
    case "response.incomplete": {
      const response = resource(value.response, tools, request);
      const expected =
        value.type === "response.created"
          ? "in_progress"
          : value.type.slice("response.".length);
      if (response.status !== expected) throw invalid();
      return { ...base, type: value.type, response };
    }
    case "response.output_item.added":
    case "response.output_item.done":
      if (!index(value.output_index)) throw invalid();
      return {
        ...base,
        type: value.type,
        output_index: value.output_index,
        item: item(value.item),
      };
    case "response.output_text.delta":
    case "response.output_text.done":
      if (
        !id(value.item_id) ||
        !index(value.output_index) ||
        !index(value.content_index)
      )
        throw invalid();
      if (value.type === "response.output_text.delta") {
        if (typeof value.delta !== "string") throw invalid();
        return {
          ...base,
          type: value.type,
          item_id: value.item_id,
          output_index: value.output_index,
          content_index: value.content_index,
          delta: value.delta,
        };
      }
      if (typeof value.text !== "string") throw invalid();
      return {
        ...base,
        type: value.type,
        item_id: value.item_id,
        output_index: value.output_index,
        content_index: value.content_index,
        text: value.text,
      };
    case "response.content_part.added":
    case "response.content_part.done":
      if (
        !id(value.item_id) ||
        !index(value.output_index) ||
        !index(value.content_index) ||
        !record(value.part) ||
        value.part.type !== "output_text" ||
        typeof value.part.text !== "string"
      )
        throw invalid();
      return {
        ...base,
        type: value.type,
        item_id: value.item_id,
        output_index: value.output_index,
        content_index: value.content_index,
        part: { type: "output_text", text: value.part.text, annotations: [] },
      };
    case "response.function_call_arguments.done":
      if (
        !id(value.item_id) ||
        !index(value.output_index) ||
        typeof value.arguments !== "string"
      )
        throw invalid();
      return {
        ...base,
        type: value.type,
        item_id: value.item_id,
        output_index: value.output_index,
        arguments: value.arguments,
      };
    default:
      throw invalid();
  }
}
