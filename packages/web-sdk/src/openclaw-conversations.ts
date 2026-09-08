import {
  getOpenClawConnectionProviderUrl,
  OpenClawConnectionError,
  type OpenClawConnection,
} from "./openclaw-connection.js";

// The projection permits 128 KiB of text characters. JSON escaping and UTF-8
// encoding can expand that substantially, so retain Bookhand's prior 1 MiB
// transport ceiling and apply the tighter semantic limits after parsing.
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_CONVERSATIONS = 8;
const MAX_ENTRIES = 200;
const MAX_ENTRY_TEXT = 16_384;
const MAX_TOTAL_TEXT = 128 * 1024;
const CONVERSATION_ID = /^[a-f0-9]{36}$/;
const RESPONSE_ID = /^[A-Za-z0-9_.:-]{1,256}$/;

export interface OpenClawConversationDescriptor {
  readonly conversationId: string;
  /** Provider expiry time in epoch milliseconds. */
  readonly expiresAt: number;
  readonly canContinue: boolean;
  readonly previousResponseId?: string;
}

export interface OpenClawExecutionHistoryEntry {
  readonly kind: "input" | "assistant";
  readonly text: string;
}

export interface OpenClawExecutionHistory extends OpenClawConversationDescriptor {
  readonly projection: "execution-history";
  readonly entries: readonly OpenClawExecutionHistoryEntry[];
  readonly truncated: boolean;
}

export interface OpenClawConversationRequestOptions {
  readonly signal?: AbortSignal;
}

export interface CreateOpenClawConversationClientOptions {
  readonly connection: OpenClawConnection;
  readonly getAccessToken: (signal?: AbortSignal) => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

export interface OpenClawConversationClient {
  list(
    options?: OpenClawConversationRequestOptions,
  ): Promise<readonly OpenClawConversationDescriptor[]>;
  history(
    conversationId: string,
    options?: OpenClawConversationRequestOptions,
  ): Promise<OpenClawExecutionHistory>;
}

export type OpenClawConversationUnavailableCode =
  "conversation_unavailable" | "conversation_changed";

export class OpenClawConversationUnavailableError extends Error {
  readonly code: OpenClawConversationUnavailableCode;
  readonly status: 404 | 409;

  constructor(code: OpenClawConversationUnavailableCode, status: 404 | 409) {
    super("This OpenClaw conversation is no longer available");
    this.name = "OpenClawConversationUnavailableError";
    this.code = code;
    this.status = status;
  }
}

export function createOpenClawConversationClient(
  options: CreateOpenClawConversationClientOptions,
): OpenClawConversationClient {
  const providerUrl = getOpenClawConnectionProviderUrl(options.connection);
  const baseUrl = providerUrl.endsWith("/agent-connect")
    ? `${providerUrl}/v1/conversations`
    : `${providerUrl}/v1/agent-connect/conversations`;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new OpenClawConnectionError(
      "invalid_input",
      "Fetch is required for OpenClaw conversation history",
    );
  }
  if (typeof options.getAccessToken !== "function") {
    throw new OpenClawConnectionError(
      "invalid_input",
      "An access token getter is required for OpenClaw conversation history",
    );
  }

  const request = async (
    url: string,
    requestOptions: OpenClawConversationRequestOptions | undefined,
  ): Promise<unknown> => {
    const signal = requestOptions?.signal;
    signal?.throwIfAborted();
    const accessToken = await options.getAccessToken(signal);
    signal?.throwIfAborted();
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      throw new OpenClawConnectionError(
        "reauthorization_required",
        "OpenClaw access token getter returned an empty token",
      );
    }

    let response: Response;
    try {
      response = await fetchImplementation(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new OpenClawConnectionError(
        "transport_error",
        "OpenClaw conversation history request failed",
        { cause: error },
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new OpenClawConnectionError(
        "reauthorization_required",
        "OpenClaw conversation history authorization failed",
        { status: response.status },
      );
    }

    let value: unknown;
    try {
      value = await readJson(response);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof OpenClawConnectionError) throw error;
      throw new OpenClawConnectionError(
        "transport_error",
        "OpenClaw conversation history response could not be read",
        { cause: error },
      );
    }
    const unavailable = unavailableOutcome(response.status, value);
    if (unavailable) {
      throw new OpenClawConversationUnavailableError(
        unavailable.code,
        unavailable.status,
      );
    }
    if (!response.ok) {
      throw new OpenClawConnectionError(
        "transport_error",
        "OpenClaw conversation history request failed",
        { status: response.status },
      );
    }
    return value;
  };

  return Object.freeze({
    async list(
      requestOptions?: OpenClawConversationRequestOptions,
    ): Promise<readonly OpenClawConversationDescriptor[]> {
      return parseConversationDescriptors(
        await request(baseUrl, requestOptions),
      );
    },
    async history(
      conversationId: string,
      requestOptions?: OpenClawConversationRequestOptions,
    ): Promise<OpenClawExecutionHistory> {
      if (!CONVERSATION_ID.test(conversationId)) {
        throw new OpenClawConnectionError(
          "invalid_input",
          "OpenClaw conversation identifier is invalid",
        );
      }
      return parseExecutionHistory(
        await request(
          `${baseUrl}/${encodeURIComponent(conversationId)}/history`,
          requestOptions,
        ),
      );
    },
  });
}

function parseConversationDescriptors(
  value: unknown,
): readonly OpenClawConversationDescriptor[] {
  const root = record(value);
  if (
    !root ||
    !Array.isArray(root.conversations) ||
    root.conversations.length > MAX_CONVERSATIONS
  ) {
    throw invalidResponse();
  }
  return Object.freeze(root.conversations.map(parseDescriptor));
}

function parseExecutionHistory(value: unknown): OpenClawExecutionHistory {
  const root = record(value);
  if (
    !root ||
    root.projection !== "execution-history" ||
    !Array.isArray(root.entries) ||
    root.entries.length > MAX_ENTRIES ||
    typeof root.truncated !== "boolean"
  ) {
    throw invalidResponse();
  }
  const descriptor = parseDescriptor(root);
  let total = 0;
  const entries = root.entries.map((value) => {
    const entry = record(value);
    if (
      !entry ||
      (entry.kind !== "input" && entry.kind !== "assistant") ||
      typeof entry.text !== "string" ||
      entry.text.length === 0 ||
      entry.text.length > MAX_ENTRY_TEXT
    ) {
      throw invalidResponse();
    }
    total += entry.text.length;
    if (total > MAX_TOTAL_TEXT) throw invalidResponse();
    return Object.freeze({ kind: entry.kind, text: entry.text });
  });
  return Object.freeze({
    ...descriptor,
    projection: "execution-history",
    entries: Object.freeze(entries),
    truncated: root.truncated,
  });
}

function parseDescriptor(value: unknown): OpenClawConversationDescriptor {
  const descriptor = record(value);
  if (
    !descriptor ||
    typeof descriptor.conversationId !== "string" ||
    !CONVERSATION_ID.test(descriptor.conversationId) ||
    typeof descriptor.expiresAt !== "number" ||
    !Number.isSafeInteger(descriptor.expiresAt) ||
    descriptor.expiresAt < 0 ||
    typeof descriptor.canContinue !== "boolean"
  ) {
    throw invalidResponse();
  }
  const previousResponseId = descriptor.previousResponseId;
  if (
    (descriptor.canContinue &&
      (typeof previousResponseId !== "string" ||
        !RESPONSE_ID.test(previousResponseId))) ||
    (!descriptor.canContinue && previousResponseId !== undefined)
  ) {
    throw invalidResponse();
  }
  const result: OpenClawConversationDescriptor = {
    conversationId: descriptor.conversationId,
    expiresAt: descriptor.expiresAt,
    canContinue: descriptor.canContinue,
    ...(typeof previousResponseId === "string" ? { previousResponseId } : {}),
  };
  return Object.freeze(result);
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw invalidResponse();
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw invalidResponse(
      "OpenClaw conversation history response was too large",
    );
  }
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel();
      throw invalidResponse(
        "OpenClaw conversation history response was too large",
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text);
  } catch {
    throw invalidResponse();
  }
}

function unavailableOutcome(
  status: number,
  value: unknown,
):
  | {
      readonly code: OpenClawConversationUnavailableCode;
      readonly status: 404 | 409;
    }
  | undefined {
  const error = record(record(value)?.error);
  if (
    error?.type !== "invalid_request_error" ||
    typeof error.message !== "string"
  ) {
    return undefined;
  }
  if (status === 404 && error.code === "conversation_unavailable") {
    return { code: "conversation_unavailable", status: 404 };
  }
  if (status === 409 && error.code === "conversation_changed") {
    return { code: "conversation_changed", status: 409 };
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function invalidResponse(
  message = "OpenClaw returned an invalid conversation history response",
): OpenClawConnectionError {
  return new OpenClawConnectionError("invalid_response", message);
}
