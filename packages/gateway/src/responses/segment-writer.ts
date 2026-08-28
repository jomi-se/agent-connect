import {
  buildResponseResource,
  SequenceCounter,
  type ResponseError,
  type ResponseErrorPayload,
  type ResponseFunctionTool,
  type ResponseOutputItem,
  type ResponseResource,
  type ResponseStatus,
  type ResponseStreamEvent,
} from "./protocol.js";

export interface SegmentWriterOptions {
  readonly responseId: string;
  readonly createdAt: number;
  readonly previousResponseId: string | null;
  readonly tools: readonly ResponseFunctionTool[];
  readonly now: () => number;
  readonly createId: () => string;
}

/**
 * Builds the public event sequence of one response segment: item indices,
 * `sequence_number` allocation, and the accumulated output items. It owns no
 * persistence and no chain state, so the engine keeps every durable decision.
 */
export class SegmentWriter {
  readonly output: ResponseOutputItem[] = [];
  private readonly options: SegmentWriterOptions;
  private readonly sequence = new SequenceCounter();
  private outputIndex = 0;
  private text: { readonly id: string; value: string } | undefined;

  constructor(options: SegmentWriterOptions) {
    this.options = options;
  }

  resource(
    status: ResponseStatus,
    error: ResponseError | null = null,
  ): ResponseResource {
    return buildResponseResource({
      id: this.options.responseId,
      createdAt: this.options.createdAt,
      completedAt:
        status === "in_progress" ? null : Math.floor(this.options.now() / 1000),
      status,
      previousResponseId: this.options.previousResponseId,
      output: [...this.output],
      error,
      tools: this.options.tools,
    });
  }

  *begin(): Generator<ResponseStreamEvent> {
    yield {
      type: "response.created",
      sequence_number: this.sequence.take(),
      response: this.resource("in_progress"),
    };
    yield {
      type: "response.in_progress",
      sequence_number: this.sequence.take(),
      response: this.resource("in_progress"),
    };
  }

  *appendText(delta: string): Generator<ResponseStreamEvent> {
    if (!this.text) {
      this.text = { id: `msg_${this.options.createId()}`, value: "" };
      yield {
        type: "response.output_item.added",
        sequence_number: this.sequence.take(),
        output_index: this.outputIndex,
        item: {
          type: "message",
          id: this.text.id,
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      };
      yield {
        type: "response.content_part.added",
        sequence_number: this.sequence.take(),
        item_id: this.text.id,
        output_index: this.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      };
    }
    this.text.value += delta;
    yield {
      type: "response.output_text.delta",
      sequence_number: this.sequence.take(),
      item_id: this.text.id,
      output_index: this.outputIndex,
      content_index: 0,
      delta,
    };
  }

  *closeText(): Generator<ResponseStreamEvent> {
    const text = this.text;
    if (!text) return;
    this.text = undefined;
    const part = {
      type: "output_text" as const,
      text: text.value,
      annotations: [] as readonly never[],
    };
    yield {
      type: "response.output_text.done",
      sequence_number: this.sequence.take(),
      item_id: text.id,
      output_index: this.outputIndex,
      content_index: 0,
      text: text.value,
    };
    yield {
      type: "response.content_part.done",
      sequence_number: this.sequence.take(),
      item_id: text.id,
      output_index: this.outputIndex,
      content_index: 0,
      part,
    };
    const item: ResponseOutputItem = {
      type: "message",
      id: text.id,
      status: "completed",
      role: "assistant",
      content: [part],
    };
    this.output.push(item);
    yield {
      type: "response.output_item.done",
      sequence_number: this.sequence.take(),
      output_index: this.outputIndex,
      item,
    };
    this.outputIndex += 1;
  }

  *functionCall(
    item: Extract<ResponseOutputItem, { type: "function_call" }>,
  ): Generator<ResponseStreamEvent> {
    yield {
      type: "response.output_item.added",
      sequence_number: this.sequence.take(),
      output_index: this.outputIndex,
      item: { ...item, status: "in_progress" },
    };
    yield {
      type: "response.function_call_arguments.done",
      sequence_number: this.sequence.take(),
      item_id: item.id,
      output_index: this.outputIndex,
      arguments: item.arguments,
    };
    this.output.push(item);
    yield {
      type: "response.output_item.done",
      sequence_number: this.sequence.take(),
      output_index: this.outputIndex,
      item,
    };
    this.outputIndex += 1;
  }

  *completed(): Generator<ResponseStreamEvent> {
    yield {
      type: "response.completed",
      sequence_number: this.sequence.take(),
      response: this.resource("completed"),
    };
  }

  /**
   * The pinned document has no `response.cancelled` event, so a cancelled
   * segment terminates as `response.incomplete` carrying the cancelled status.
   */
  *cancelled(error: ResponseError): Generator<ResponseStreamEvent> {
    yield {
      type: "response.incomplete",
      sequence_number: this.sequence.take(),
      response: this.resource("cancelled", error),
    };
  }

  *failed(
    error: ResponseError,
    payload: Omit<ResponseErrorPayload, "code" | "message">,
  ): Generator<ResponseStreamEvent> {
    yield {
      type: "error",
      sequence_number: this.sequence.take(),
      error: { ...payload, code: error.code, message: error.message },
    };
    yield {
      type: "response.failed",
      sequence_number: this.sequence.take(),
      response: this.resource("failed", error),
    };
  }
}
