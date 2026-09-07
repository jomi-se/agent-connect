import type {
  ApprovedApplicationTool,
  VerifiedDelegatedGrant,
} from "../delegated-grants.js";

export const MAX_RESPONSE_REQUEST_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_INSTRUCTIONS_BYTES = 16 * 1024;
const MAX_INPUT_ITEMS = 64;
const MAX_TOOL_OUTPUTS = 16;
const REQUEST_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "max_output_tokens",
  "temperature",
  "top_p",
  "previous_response_id",
]);

export interface ContinuationExpectation {
  readonly responseId: string;
  readonly pendingCallIds: readonly string[];
}

export interface BoundedResponseRequest {
  readonly stream: boolean;
  readonly previousResponseId?: string;
  readonly upstreamBody: Readonly<Record<string, unknown>>;
}

export class ScopedProxyRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function buildBoundedUpstreamRequest(
  value: unknown,
  grant: VerifiedDelegatedGrant,
  continuation?: ContinuationExpectation,
): BoundedResponseRequest {
  const body = record(value);
  if (!body) throw invalid("Request body must be a JSON object");
  for (const key of Object.keys(body)) {
    if (!REQUEST_FIELDS.has(key)) throw invalid(`Unsupported field: ${key}`);
  }
  if (body.model !== "openclaw/default") {
    throw invalid("model must be openclaw/default");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw invalid("stream must be boolean");
  }
  const previous = optionalId(
    body.previous_response_id,
    "previous_response_id",
  );
  if ((previous === undefined) !== (continuation === undefined)) {
    throw new ScopedProxyRequestError(
      "unknown_previous_response_id",
      "The previous response is unavailable for this grant",
    );
  }
  if (continuation && previous !== continuation.responseId) {
    throw new ScopedProxyRequestError(
      "unknown_previous_response_id",
      "The previous response is unavailable for this grant",
    );
  }

  const input = validateInput(body.input, continuation);
  const tools = validateAndBuildTools(body.tools, grant.applicationTools);
  const instructions = optionalText(
    body.instructions,
    "instructions",
    MAX_INSTRUCTIONS_BYTES,
  );
  if (continuation?.pendingCallIds.length && instructions !== undefined) {
    throw invalid(
      "instructions cannot change during function output continuation",
    );
  }
  const toolChoice = validateToolChoice(
    body.tool_choice,
    new Set(grant.applicationTools.map((tool) => tool.name)),
  );
  const maxOutputTokens = optionalInteger(
    body.max_output_tokens,
    "max_output_tokens",
    1,
    4096,
  );
  const temperature = optionalNumber(body.temperature, "temperature", 0, 2);
  const topP = optionalNumber(body.top_p, "top_p", 0, 1);

  return {
    stream: body.stream === true,
    ...(previous === undefined ? {} : { previousResponseId: previous }),
    upstreamBody: {
      // The public model is a logical alias. Agent selection is carried only
      // in the private server-generated header.
      model: "openclaw",
      input,
      tools,
      stream: body.stream === true,
      ...(previous === undefined ? {} : { previous_response_id: previous }),
      ...(instructions === undefined ? {} : { instructions }),
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      ...(maxOutputTokens === undefined
        ? {}
        : { max_output_tokens: maxOutputTokens }),
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { top_p: topP }),
    },
  };
}

function validateInput(
  value: unknown,
  continuation: ContinuationExpectation | undefined,
): string | readonly Record<string, unknown>[] {
  if (typeof value === "string") {
    requireText(value, "input", MAX_TEXT_BYTES);
    if (continuation?.pendingCallIds.length) {
      throw invalid(
        "A pending function call requires function_call_output input",
      );
    }
    return value;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_INPUT_ITEMS
  ) {
    throw invalid("input must be a bounded string or non-empty item array");
  }
  const items = value.map((candidate) => validateInputItem(candidate));
  const outputs = items.filter((item) => item.type === "function_call_output");
  const messages = items.filter((item) => item.type === "message");
  if (outputs.length > MAX_TOOL_OUTPUTS) {
    throw invalid("Too many function outputs");
  }
  const pending = continuation?.pendingCallIds ?? [];
  if (pending.length > 0) {
    if (messages.length > 0 || outputs.length !== items.length) {
      throw invalid("Function output continuation cannot include new messages");
    }
    const actual = outputs.map((item) => String(item.call_id)).sort();
    if (
      new Set(actual).size !== actual.length ||
      actual.join("\0") !== [...pending].sort().join("\0")
    ) {
      throw invalid("Function outputs must exactly answer the pending calls");
    }
  } else if (outputs.length > 0) {
    throw invalid("Function output has no pending call in this conversation");
  }
  if (messages.length === 0 && outputs.length === 0) {
    throw invalid("input contains no supported items");
  }
  return items;
}

function validateInputItem(value: unknown): Record<string, unknown> {
  const item = record(value);
  if (!item || typeof item.type !== "string") {
    throw invalid("Each input item must have a supported type");
  }
  if (item.type === "function_call_output") {
    requireOnly(item, ["type", "call_id", "output"]);
    const callId = requiredId(item.call_id, "call_id");
    const output = requiredText(item.output, "output", MAX_TEXT_BYTES);
    return { type: "function_call_output", call_id: callId, output };
  }
  if (item.type === "message") {
    requireOnly(item, ["type", "role", "content"]);
    if (item.role !== "user")
      throw invalid("Only user message items are accepted");
    const content = validateMessageContent(item.content);
    return { type: "message", role: "user", content };
  }
  throw invalid(`Unsupported input item type: ${item.type}`);
}

function validateMessageContent(value: unknown): string | readonly unknown[] {
  if (typeof value === "string")
    return requiredText(value, "content", MAX_TEXT_BYTES);
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw invalid("Message content must be text or input_text parts");
  }
  let total = 0;
  return value.map((candidate) => {
    const part = record(candidate);
    if (!part) throw invalid("Invalid message content part");
    requireOnly(part, ["type", "text"]);
    if (part.type !== "input_text") {
      throw invalid("Media and non-text content are not supported");
    }
    const text = requiredText(part.text, "text", MAX_TEXT_BYTES);
    total += Buffer.byteLength(text);
    if (total > MAX_TEXT_BYTES) throw invalid("Message content is too large");
    return { type: "input_text", text };
  });
}

function validateAndBuildTools(
  value: unknown,
  approved: readonly ApprovedApplicationTool[],
): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw invalid("tools must be an array");
  const normalized = value.map((candidate) => {
    const tool = record(candidate);
    if (!tool) throw invalid("Invalid function tool");
    requireOnly(tool, ["type", "name", "description", "parameters"]);
    if (
      tool.type !== "function" ||
      typeof tool.name !== "string" ||
      typeof tool.description !== "string" ||
      !record(tool.parameters)
    ) {
      throw invalid("Invalid function tool");
    }
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    };
  });
  if (canonicalJson(normalized) !== canonicalJson(approved)) {
    throw new ScopedProxyRequestError(
      "tool_snapshot_mismatch",
      "The requested tools do not match owner consent",
    );
  }
  return approved.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

function validateToolChoice(
  value: unknown,
  approved: ReadonlySet<string>,
): unknown {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "none" || value === "required")
    return value;
  const choice = record(value);
  if (!choice) throw invalid("Invalid tool_choice");
  requireOnly(choice, ["type", "name"]);
  if (
    choice.type !== "function" ||
    typeof choice.name !== "string" ||
    !approved.has(choice.name)
  ) {
    throw invalid("tool_choice must select an approved application tool");
  }
  return { type: "function", name: choice.name };
}

function optionalId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredId(value, label);
}

function requiredId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9_.:-]+$/.test(value)
  ) {
    throw invalid(`${label} is invalid`);
  }
  return value;
}

function optionalText(
  value: unknown,
  label: string,
  limit: number,
): string | undefined {
  return value === undefined ? undefined : requiredText(value, label, limit);
}

function requiredText(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string") throw invalid(`${label} must be text`);
  requireText(value, label, limit);
  return value;
}

function requireText(value: string, label: string, limit: number): void {
  if (Buffer.byteLength(value) > limit || /\u0000/.test(value)) {
    throw invalid(`${label} is too large or contains NUL`);
  }
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw invalid(`${label} is outside the supported range`);
  }
  return Number(value);
}

function optionalNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalid(`${label} is outside the supported range`);
  }
  return value;
}

function requireOnly(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) throw invalid(`Unsupported item field: ${key}`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function invalid(message: string): ScopedProxyRequestError {
  return new ScopedProxyRequestError("invalid_request", message);
}
