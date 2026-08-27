import {
  hashToolSnapshot,
  InvalidToolSnapshotError,
  validateToolSnapshot,
  type GatewayToolDefinition,
} from "../tool-snapshot.js";
import { ResponseApiError } from "./errors.js";
import { AGENT_CONNECT_MODEL } from "./protocol.js";

/** Request members of the pinned `CreateResponseBody` that version 0 accepts. */
const ACCEPTED_FIELDS = new Set([
  "model",
  "input",
  "previous_response_id",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "store",
]);

/**
 * Request members of the pinned `CreateResponseBody` that version 0 knows and
 * deliberately does not support. They fail as `unsupported_feature` so a client
 * learns the difference between "misspelled" and "outside the profile".
 */
const KNOWN_UNSUPPORTED_FIELDS = new Set([
  "include",
  "metadata",
  "text",
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "stream_options",
  "background",
  "max_output_tokens",
  "max_tool_calls",
  "reasoning",
  "safety_identifier",
  "prompt_cache_key",
  "truncation",
  "instructions",
  "service_tier",
  "top_logprobs",
]);

/** Pinned `FunctionCallOutputItemParam.call_id`. */
const CALL_ID_MAX_LENGTH = 64;
const MAX_PROMPT_LENGTH = 100_000;
const MAX_OUTPUT_LENGTH = 1_000_000;

export interface ParsedInitialRequest {
  readonly kind: "initial";
  readonly stream: boolean;
  readonly prompt: string;
}

export interface ParsedContinuationRequest {
  readonly kind: "continuation";
  readonly stream: boolean;
  readonly previousResponseId: string;
  readonly callId: string;
  readonly output: string;
}

export type ParsedResponseRequest =
  ParsedInitialRequest | ParsedContinuationRequest;

/**
 * Validates one `POST /v1/responses` body against the version 0 profile and the
 * application session's approved tool snapshot. Rejects unknown and unsupported
 * fields rather than discarding them.
 */
export function parseResponseRequest(
  value: unknown,
  approved: {
    readonly tools: readonly GatewayToolDefinition[];
    readonly toolHash: string;
  },
): ParsedResponseRequest {
  if (!isRecord(value)) {
    throw new ResponseApiError("invalid_request", "body must be a JSON object");
  }

  for (const key of Object.keys(value)) {
    if (ACCEPTED_FIELDS.has(key)) continue;
    // An explicit null is treated as absent: several standard clients serialize
    // unset options as null rather than omitting them.
    if (value[key] === null && KNOWN_UNSUPPORTED_FIELDS.has(key)) continue;
    if (KNOWN_UNSUPPORTED_FIELDS.has(key)) {
      throw new ResponseApiError(
        "unsupported_feature",
        `${key} is outside the Agent Connect version 0 profile`,
        key,
      );
    }
    throw new ResponseApiError("invalid_request", `unknown field: ${key}`, key);
  }

  if (value["model"] !== AGENT_CONNECT_MODEL) {
    throw new ResponseApiError(
      "model_not_found",
      `model must be ${AGENT_CONNECT_MODEL}`,
      "model",
    );
  }

  const stream = optionalBoolean(value, "stream") ?? false;
  const store = optionalBoolean(value, "store");
  if (store === false) {
    throw new ResponseApiError(
      "unsupported_feature",
      "store: false is outside the Agent Connect version 0 profile",
      "store",
    );
  }
  const toolChoice = value["tool_choice"];
  if (
    toolChoice !== undefined &&
    toolChoice !== null &&
    toolChoice !== "auto"
  ) {
    throw new ResponseApiError(
      "unsupported_feature",
      "tool_choice must be omitted, null, or auto",
      "tool_choice",
    );
  }
  const parallel = optionalBoolean(value, "parallel_tool_calls");
  if (parallel === true) {
    throw new ResponseApiError(
      "unsupported_feature",
      "parallel_tool_calls must be omitted, null, or false",
      "parallel_tool_calls",
    );
  }

  requireApprovedTools(value["tools"], approved);

  const previousResponseId = value["previous_response_id"];
  if (previousResponseId === undefined || previousResponseId === null) {
    return { kind: "initial", stream, prompt: parsePrompt(value["input"]) };
  }
  if (typeof previousResponseId !== "string" || previousResponseId === "") {
    throw new ResponseApiError(
      "invalid_request",
      "previous_response_id must be a non-empty string",
      "previous_response_id",
    );
  }
  const output = parseFunctionCallOutput(value["input"]);
  return { kind: "continuation", stream, previousResponseId, ...output };
}

function requireApprovedTools(
  value: unknown,
  approved: {
    readonly tools: readonly GatewayToolDefinition[];
    readonly toolHash: string;
  },
): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    throw new ResponseApiError(
      "invalid_request",
      "tools must be an array",
      "tools",
    );
  }
  const canonical = value.map((candidate) => {
    if (!isRecord(candidate) || candidate["type"] !== "function") {
      throw new ResponseApiError(
        "unsupported_feature",
        "only function tools are supported",
        "tools",
      );
    }
    // `strict` is fixed by the profile at true and is not part of the hash. A
    // different value is a mismatch against what the user approved, not a new
    // configuration.
    const strict = candidate["strict"];
    if (strict !== undefined && strict !== null && strict !== true) {
      throw new ResponseApiError(
        "tool_snapshot_mismatch",
        "strict is fixed at true by the Agent Connect profile",
        "tools",
      );
    }
    return {
      name: candidate["name"],
      description: candidate["description"],
      inputSchema: candidate["parameters"],
    };
  });

  let hash: string;
  try {
    hash = hashToolSnapshot(validateToolSnapshot(canonical));
  } catch (cause) {
    if (cause instanceof InvalidToolSnapshotError) {
      throw new ResponseApiError(
        "tool_snapshot_mismatch",
        cause.message,
        "tools",
      );
    }
    throw cause;
  }
  if (hash !== approved.toolHash) {
    throw new ResponseApiError(
      "tool_snapshot_mismatch",
      "tools do not match the approved snapshot for this application session",
      "tools",
    );
  }
}

function parsePrompt(value: unknown): string {
  if (typeof value === "string") return requireText(value);
  if (!Array.isArray(value) || value.length !== 1) {
    throw new ResponseApiError(
      "unsupported_feature",
      "input must be a string or exactly one user message",
      "input",
    );
  }
  const item = value[0];
  if (
    !isRecord(item) ||
    item["type"] !== "message" ||
    item["role"] !== "user" ||
    !hasOnlyKeys(item, ["type", "role", "content", "id", "status"])
  ) {
    throw new ResponseApiError(
      "unsupported_feature",
      "input items must be one user message",
      "input",
    );
  }
  const content = item["content"];
  if (typeof content === "string") return requireText(content);
  if (!Array.isArray(content) || content.length !== 1) {
    throw new ResponseApiError(
      "unsupported_feature",
      "message content must be a string or exactly one input_text part",
      "input",
    );
  }
  const part = content[0];
  if (!isRecord(part) || part["type"] !== "input_text") {
    throw new ResponseApiError(
      "unsupported_feature",
      "only input_text content is supported",
      "input",
    );
  }
  return requireText(part["text"]);
}

function parseFunctionCallOutput(value: unknown): {
  readonly callId: string;
  readonly output: string;
} {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new ResponseApiError(
      "unsupported_feature",
      "a continuation must supply exactly one function_call_output",
      "input",
    );
  }
  const item = value[0];
  if (
    !isRecord(item) ||
    item["type"] !== "function_call_output" ||
    !hasOnlyKeys(item, ["type", "call_id", "output", "id", "status"])
  ) {
    throw new ResponseApiError(
      "unsupported_feature",
      "a continuation input item must be one function_call_output",
      "input",
    );
  }
  const callId = item["call_id"];
  if (
    typeof callId !== "string" ||
    callId.length === 0 ||
    callId.length > CALL_ID_MAX_LENGTH
  ) {
    throw new ResponseApiError(
      "invalid_request",
      `call_id must be 1 to ${CALL_ID_MAX_LENGTH} characters`,
      "input",
    );
  }
  const output = item["output"];
  if (typeof output !== "string") {
    throw new ResponseApiError(
      "unsupported_feature",
      "function_call_output.output must be a JSON string",
      "input",
    );
  }
  if (output.length > MAX_OUTPUT_LENGTH) {
    throw new ResponseApiError(
      "invalid_request",
      "function_call_output.output is too large",
      "input",
    );
  }
  return { callId, output };
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ResponseApiError(
      "invalid_request",
      "input text must be a non-empty string",
      "input",
    );
  }
  if (value.length > MAX_PROMPT_LENGTH) {
    throw new ResponseApiError(
      "invalid_request",
      "input text is too large",
      "input",
    );
  }
  return value;
}

function optionalBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) return undefined;
  if (typeof candidate !== "boolean") {
    throw new ResponseApiError(
      "invalid_request",
      `${key} must be a boolean`,
      key,
    );
  }
  return candidate;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
