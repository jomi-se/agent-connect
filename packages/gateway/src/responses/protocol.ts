// The subset of the pinned Open Responses document that version 0 emits.
// Every shape here is traceable to `contract/open-responses/openapi.json` at
// commit 92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c (`info.version` 2026-04-24);
// `packages/gateway/test/open-responses-protocol.test.ts` validates produced
// values against that document rather than against these declarations.

import type { GatewayToolDefinition } from "../tool-snapshot.js";

/** The only model identifier the Agent Connect profile accepts. */
export const AGENT_CONNECT_MODEL = "agent-connect/default";

/**
 * `ResponseResource` requires six non-nullable sampling and service fields that
 * a harness-backed gateway does not decide. Version 0 renders them as
 * documented constants; see "Required response fields and the constant profile"
 * in docs/plan/open-responses-vertical-slice.md.
 */
export const CONSTANT_PROFILE = {
  temperature: 1,
  top_p: 1,
  presence_penalty: 0,
  frequency_penalty: 0,
  top_logprobs: 0,
  service_tier: "default",
} as const;

export interface ResponseFunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Fixed by the Agent Connect profile; not part of consent or the hash. */
  readonly strict: true;
}

export interface ResponseOutputTextContent {
  readonly type: "output_text";
  readonly text: string;
  readonly annotations: readonly never[];
}

export interface ResponseMessageItem {
  readonly type: "message";
  readonly id: string;
  readonly status: "in_progress" | "completed" | "incomplete";
  readonly role: "assistant";
  readonly content: readonly ResponseOutputTextContent[];
}

export interface ResponseFunctionCallItem {
  readonly type: "function_call";
  readonly id: string;
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
  readonly status: "in_progress" | "completed" | "incomplete";
}

export type ResponseOutputItem = ResponseMessageItem | ResponseFunctionCallItem;

export interface ResponseError {
  readonly code: string;
  readonly message: string;
}

export type ResponseStatus =
  "in_progress" | "completed" | "failed" | "incomplete" | "cancelled";

export interface ResponseResource {
  readonly id: string;
  readonly object: "response";
  readonly created_at: number;
  readonly completed_at: number | null;
  readonly status: ResponseStatus;
  readonly incomplete_details: null;
  readonly model: string;
  readonly previous_response_id: string | null;
  readonly instructions: null;
  readonly output: readonly ResponseOutputItem[];
  readonly error: ResponseError | null;
  readonly tools: readonly ResponseFunctionTool[];
  readonly tool_choice: "auto";
  readonly truncation: "disabled";
  readonly parallel_tool_calls: boolean;
  readonly text: { readonly format: { readonly type: "text" } };
  readonly top_p: number;
  readonly presence_penalty: number;
  readonly frequency_penalty: number;
  readonly top_logprobs: number;
  readonly temperature: number;
  readonly reasoning: null;
  readonly usage: null;
  readonly max_output_tokens: null;
  readonly max_tool_calls: null;
  readonly store: boolean;
  readonly background: boolean;
  readonly service_tier: string;
  readonly metadata: null;
  readonly safety_identifier: null;
  readonly prompt_cache_key: null;
}

export interface ResponseErrorPayload {
  readonly type: string;
  readonly code: string | null;
  readonly message: string;
  readonly param: string | null;
}

export type ResponseStreamEvent =
  | {
      readonly type:
        | "response.created"
        | "response.in_progress"
        | "response.completed"
        | "response.failed"
        | "response.incomplete";
      readonly sequence_number: number;
      readonly response: ResponseResource;
    }
  | {
      readonly type: "response.output_item.added" | "response.output_item.done";
      readonly sequence_number: number;
      readonly output_index: number;
      readonly item: ResponseOutputItem;
    }
  | {
      readonly type:
        "response.content_part.added" | "response.content_part.done";
      readonly sequence_number: number;
      readonly item_id: string;
      readonly output_index: number;
      readonly content_index: number;
      readonly part: ResponseOutputTextContent;
    }
  | {
      readonly type: "response.output_text.delta";
      readonly sequence_number: number;
      readonly item_id: string;
      readonly output_index: number;
      readonly content_index: number;
      readonly delta: string;
    }
  | {
      readonly type: "response.output_text.done";
      readonly sequence_number: number;
      readonly item_id: string;
      readonly output_index: number;
      readonly content_index: number;
      readonly text: string;
    }
  | {
      readonly type: "response.function_call_arguments.done";
      readonly sequence_number: number;
      readonly item_id: string;
      readonly output_index: number;
      readonly arguments: string;
    }
  | {
      readonly type: "error";
      readonly sequence_number: number;
      readonly error: ResponseErrorPayload;
    };

/**
 * Projects the approved snapshot onto the returned `FunctionTool` shape.
 * `description` and `parameters` come from the snapshot and are never
 * reflected from the request.
 */
export function projectTools(
  tools: readonly GatewayToolDefinition[],
): ResponseFunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: true,
  }));
}

export interface ResponseResourceInput {
  readonly id: string;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly status: ResponseStatus;
  readonly previousResponseId: string | null;
  readonly output: readonly ResponseOutputItem[];
  readonly error: ResponseError | null;
  readonly tools: readonly ResponseFunctionTool[];
}

export function buildResponseResource(
  input: ResponseResourceInput,
): ResponseResource {
  return {
    id: input.id,
    object: "response",
    created_at: input.createdAt,
    completed_at: input.completedAt,
    status: input.status,
    incomplete_details: null,
    model: AGENT_CONNECT_MODEL,
    previous_response_id: input.previousResponseId,
    instructions: null,
    output: input.output,
    error: input.error,
    tools: input.tools,
    tool_choice: "auto",
    truncation: "disabled",
    parallel_tool_calls: false,
    text: { format: { type: "text" } },
    top_p: CONSTANT_PROFILE.top_p,
    presence_penalty: CONSTANT_PROFILE.presence_penalty,
    frequency_penalty: CONSTANT_PROFILE.frequency_penalty,
    top_logprobs: CONSTANT_PROFILE.top_logprobs,
    temperature: CONSTANT_PROFILE.temperature,
    reasoning: null,
    usage: null,
    max_output_tokens: null,
    max_tool_calls: null,
    store: true,
    background: false,
    service_tier: CONSTANT_PROFILE.service_tier,
    metadata: null,
    safety_identifier: null,
    prompt_cache_key: null,
  };
}

/** Allocates the monotonically increasing `sequence_number` of one segment. */
export class SequenceCounter {
  private next = 0;

  take(): number {
    const value = this.next;
    this.next += 1;
    return value;
  }
}
