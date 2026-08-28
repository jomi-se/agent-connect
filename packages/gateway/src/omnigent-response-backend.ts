import {
  BackendEventQueue,
  type BackendEvent,
  type BackendRun,
  type BackendStartRequest,
  type ResponseBackend,
} from "./responses/backend.js";

const INTERNAL_ORIGIN = "omnigent://internal";

export interface OmnigentResponseBackendOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Owns the long-lived Omnigent stream for one response chain, independently of
 * any single browser request. This is the coupling the old task route did not
 * have: there, a client disconnect aborted the upstream stream, which would
 * destroy a parked application call.
 */
export class OmnigentResponseBackend implements ResponseBackend {
  readonly kind = "omnigent";
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(options: OmnigentResponseBackendOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImplementation =
      options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async start(request: BackendStartRequest): Promise<BackendRun> {
    const run = new OmnigentBackendRun(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(request.providerSessionId)}`,
      request.providerSessionId,
      this.fetchImplementation,
    );
    await run.open(request);
    return run;
  }
}

class OmnigentBackendRun implements BackendRun {
  readonly providerSessionId: string;
  private readonly sessionUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly queue = new BackendEventQueue();
  private readonly controller = new AbortController();
  /**
   * Application calls published to the browser and not yet answered. While one
   * is outstanding, an Omnigent `response.completed` ends a provider response,
   * not the logical run, and must not be forwarded as a run completion.
   */
  private parked = 0;
  private closed = false;

  constructor(
    sessionUrl: string,
    providerSessionId: string,
    fetchImplementation: typeof globalThis.fetch,
  ) {
    this.sessionUrl = sessionUrl;
    this.providerSessionId = providerSessionId;
    this.fetchImplementation = fetchImplementation;
  }

  async open(request: BackendStartRequest): Promise<void> {
    const stream = await this.fetchImplementation(`${this.sessionUrl}/stream`, {
      headers: { Origin: INTERNAL_ORIGIN, Accept: "text/event-stream" },
      signal: this.controller.signal,
    });
    if (!stream.ok || !stream.body) {
      throw new Error(
        `Omnigent stream for ${this.providerSessionId} failed: HTTP ${stream.status}`,
      );
    }
    // The pump is deliberately not awaited: it outlives every client-facing
    // segment and buffers events published while no segment is open.
    void this.pump(stream.body);
    await this.post({
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
  }

  events(): AsyncIterator<BackendEvent> {
    return this.queue.iterator();
  }

  async submitOutput(providerToken: string, output: string): Promise<void> {
    await this.post({
      type: "function_call_output",
      data: { call_id: providerToken, output },
    });
    if (this.parked > 0) this.parked -= 1;
  }

  async cancel(): Promise<void> {
    await this.post({ type: "interrupt", data: {} });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.queue.end();
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const event of parseSse(body)) {
        const mapped = this.translate(event);
        if (mapped) this.queue.push(mapped);
      }
      this.queue.end();
    } catch (cause) {
      if (this.closed) return;
      this.queue.fail(
        cause instanceof Error ? cause : new Error(String(cause)),
      );
    }
  }

  /**
   * The whole translation contract. Omnigent `action_required` items, provider
   * session IDs, and ACP events stop here; only the five backend events cross.
   */
  private translate(event: Record<string, unknown>): BackendEvent | undefined {
    switch (event["type"]) {
      case "response.output_text.delta": {
        const delta = event["delta"];
        return typeof delta === "string"
          ? { type: "text.delta", delta }
          : undefined;
      }
      case "response.output_item.done": {
        const item = event["item"];
        if (
          !isRecord(item) ||
          item["type"] !== "function_call" ||
          item["status"] !== "action_required"
        ) {
          return undefined;
        }
        const providerToken = item["call_id"];
        const name = item["name"];
        if (typeof providerToken !== "string" || typeof name !== "string") {
          return {
            type: "failed",
            message: "malformed Omnigent function call",
          };
        }
        this.parked += 1;
        return {
          type: "tool.call",
          providerToken,
          name,
          arguments: stringifyArguments(item["arguments"]),
        };
      }
      case "response.completed":
        return this.parked > 0 ? undefined : { type: "completed" };
      case "response.failed":
      case "response.incomplete":
        return { type: "failed", message: terminalMessage(event) };
      case "response.cancelled":
      case "session.interrupted":
        return { type: "cancelled" };
      default:
        return undefined;
    }
  }

  private async post(body: unknown): Promise<void> {
    const result = await this.fetchImplementation(`${this.sessionUrl}/events`, {
      method: "POST",
      headers: { Origin: INTERNAL_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await result.text();
    if (!result.ok) {
      throw new Error(
        `Omnigent event post failed: HTTP ${result.status}${text ? ` — ${text.slice(0, 200)}` : ""}`,
      );
    }
  }
}

function stringifyArguments(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "{}";
  return JSON.stringify(value);
}

function terminalMessage(event: Record<string, unknown>): string {
  const response = event["response"];
  if (isRecord(response) && isRecord(response["error"])) {
    const message = response["error"]["message"];
    if (typeof message === "string") return message;
  }
  return `the user-owned runtime ended with ${String(event["type"])}`;
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const parsed = parseFrame(frame);
      if (parsed) yield parsed;
    }
  }
  const trailing = parseFrame(buffer);
  if (trailing) yield trailing;
}

function parseFrame(frame: string): Record<string, unknown> | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
