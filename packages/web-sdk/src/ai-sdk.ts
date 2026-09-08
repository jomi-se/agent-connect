import "./zod-jitless.js";

import * as openResponses from "@ai-sdk/open-responses";
import {
  jsonSchema,
  tool as defineAiSdkTool,
  type JSONValue as AiSdkJsonValue,
  type LanguageModel,
  type PrepareStepFunction,
  type ToolSet,
} from "ai";
import { createToolValidator, describeErrors } from "./tool-schema.js";
import type {
  ApplicationTool,
  ApplicationToolResult,
  JsonObject,
  JsonSchema,
} from "./types.js";

export interface AiSdkOpenResponsesModelOptions {
  /** Absolute Open Responses POST endpoint, normally ending in `/v1/responses`. */
  readonly endpoint: string;
  /** Model identifier understood by the connected gateway. */
  readonly model: string;
  /** Resolved for every HTTP attempt so a refreshed token does not require a new model. */
  readonly getAccessToken: (signal?: AbortSignal) => string | Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  /** Development-only escape hatch for a non-loopback plain HTTP endpoint. */
  readonly allowInsecureHttp?: boolean;
}

export interface AiSdkApplicationToolsOptions {
  /** Stable application connection/grant identity exposed to local tool handlers. */
  readonly connectionId: string;
}

export interface AiSdkOpenResponsesFinalStep {
  readonly finishReason:
    "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
  readonly response: { readonly id: string };
  readonly text: string;
}

/**
 * Create the browser-safe AI SDK model for an already-authorized Open Responses
 * endpoint. Authentication flow and token storage deliberately remain outside
 * this execution adapter.
 */
export function createAiSdkOpenResponsesModel(
  options: AiSdkOpenResponsesModelOptions,
): LanguageModel {
  const endpoint = parseEndpoint(
    options.endpoint,
    options.allowInsecureHttp ?? false,
  );
  if (!options.model.trim()) throw new TypeError("AI SDK model is required");

  const authenticatedFetch: typeof globalThis.fetch = async (input, init) => {
    const requestUrl = new URL(input instanceof Request ? input.url : input);
    if (requestUrl.href !== endpoint.href) {
      throw new TypeError(
        "AI SDK refused to send a bearer token outside its configured endpoint",
      );
    }
    const signal = init?.signal ?? requestSignal(input);
    signal?.throwIfAborted();
    const accessToken = await options.getAccessToken(signal);
    signal?.throwIfAborted();
    if (!accessToken.trim()) {
      throw new TypeError("AI SDK access token getter returned an empty token");
    }

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("Authorization", `Bearer ${accessToken}`);
    return (options.fetch ?? globalThis.fetch)(input, {
      ...init,
      headers,
      redirect: "error",
    });
  };

  return openResponses.createOpenResponses({
    name: "agent-connect",
    url: endpoint.href,
    fetch: authenticatedFetch,
  })(options.model);
}

/**
 * Prepare AI SDK tool-loop steps to continue through provider-owned Responses
 * state. This relies on the pinned downstream @ai-sdk/open-responses patch; it
 * uses only AI SDK's public prepareStep and provider-options surfaces.
 */
export function createAiSdkOpenResponsesPrepareStep<
  Tools extends ToolSet = ToolSet,
>(previousResponseId?: string): PrepareStepFunction<Tools> {
  if (
    (
      openResponses as unknown as {
        AGENT_CONNECT_CONTINUATION_PATCH?: unknown;
      }
    ).AGENT_CONNECT_CONTINUATION_PATCH !== "2.0.39.1"
  ) {
    throw new Error(
      "Open Responses continuation requires the reviewed Agent Connect dependency patch",
    );
  }
  if (previousResponseId !== undefined && !previousResponseId.trim()) {
    throw new TypeError("Previous Open Responses checkpoint must not be empty");
  }

  return ({ steps }) => {
    const previousStep = steps.at(-1);
    const checkpoint = previousStep?.response.id ?? previousResponseId;
    if (checkpoint === undefined) return undefined;

    if (previousStep === undefined) {
      return {
        providerOptions: {
          "agent-connect": { previousResponseId: checkpoint },
        },
      };
    }
    if (previousStep.finishReason !== "tool-calls") {
      throw new TypeError(
        "Open Responses continuation supports only completed tool-call steps",
      );
    }

    const toolMessages = previousStep.response.messages.filter(
      (message) => message.role === "tool",
    );
    if (toolMessages.length === 0) {
      throw new TypeError(
        "Open Responses tool continuation is missing function outputs",
      );
    }
    return {
      messages: toolMessages,
      providerOptions: {
        "agent-connect": { previousResponseId: checkpoint },
      },
    };
  };
}

/**
 * Reusable native-continuation settings for generateText/streamText. Disabling
 * model-call retries prevents an ambiguous admitted request from being replayed.
 */
export function createAiSdkOpenResponsesGenerationOptions<
  Tools extends ToolSet = ToolSet,
>(
  previousResponseId?: string,
): {
  readonly maxRetries: 0;
  readonly prepareStep: PrepareStepFunction<Tools>;
} {
  return Object.freeze({
    maxRetries: 0,
    prepareStep: createAiSdkOpenResponsesPrepareStep<Tools>(previousResponseId),
  });
}

/**
 * Select a new explicit checkpoint only from a successful terminal text step.
 * Callers retain the old value on errors, refusals, incomplete output, or an
 * unresolved tool-call step. Retaining that identifier does not prove it is
 * safe to reuse after an ambiguously admitted failure: callers must interrupt
 * the conversation and must not replay the uncertain request.
 */
export function selectAiSdkOpenResponsesCheckpoint(
  previousResponseId: string | undefined,
  finalStep: AiSdkOpenResponsesFinalStep,
): string | undefined {
  const candidate = finalStep.response.id.trim();
  return finalStep.finishReason === "stop" && finalStep.text.trim() && candidate
    ? candidate
    : previousResponseId;
}

/**
 * Adapt one already-selected, fixed ApplicationTool snapshot to AI SDK tools.
 * Passing `snapshot.tools` from createWebMcpToolSnapshot uses the same path and
 * performs no second native WebMCP discovery.
 */
export function createAiSdkApplicationTools(
  applicationTools: readonly ApplicationTool[],
  options: AiSdkApplicationToolsOptions,
): ToolSet {
  if (!options.connectionId.trim()) {
    throw new TypeError("AI SDK application tool connectionId is required");
  }

  const result = Object.create(null) as ToolSet;
  for (const applicationTool of applicationTools) {
    const name = applicationTool.name;
    if (!name.trim() || !applicationTool.description.trim()) {
      throw new TypeError("Invalid application tool definition");
    }
    if (Object.hasOwn(result, name)) {
      throw new TypeError(`Duplicate application tool name: ${name}`);
    }

    const inputSchema = freezeJson(cloneSchema(applicationTool.inputSchema));
    const validate = createToolValidator(inputSchema);
    const execute = applicationTool.execute.bind(applicationTool);
    result[name] = defineAiSdkTool({
      description: applicationTool.description,
      inputSchema: jsonSchema<JsonObject>(
        inputSchema as unknown as Parameters<typeof jsonSchema<JsonObject>>[0],
        {
          validate(value) {
            const validation = validate(value);
            return validation.valid
              ? { success: true, value: value as JsonObject }
              : {
                  success: false,
                  error: new TypeError(describeErrors(validation)),
                };
          },
        },
      ),
      async execute(input, invocation) {
        invocation.abortSignal?.throwIfAborted();
        const output = await execute(input, {
          ...(invocation.abortSignal ? { signal: invocation.abortSignal } : {}),
          connectionId: options.connectionId,
          toolName: name,
          meta: null,
          actionId: invocation.toolCallId,
        });
        invocation.abortSignal?.throwIfAborted();
        return output;
      },
      toModelOutput({ output }) {
        return toAiSdkToolOutput(output);
      },
    });
  }
  return Object.freeze(result);
}

function parseEndpoint(value: string, allowInsecureHttp: boolean): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("AI SDK endpoint must be an absolute URL");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new TypeError(
      "AI SDK endpoint must not contain credentials or a fragment",
    );
  }
  if (
    endpoint.protocol !== "https:" &&
    !(
      endpoint.protocol === "http:" &&
      (allowInsecureHttp || isLoopbackHost(endpoint.hostname))
    )
  ) {
    throw new TypeError(
      "AI SDK endpoint must use HTTPS (plain HTTP is limited to loopback)",
    );
  }
  return endpoint;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function requestSignal(input: RequestInfo | URL): AbortSignal | undefined {
  return input instanceof Request ? input.signal : undefined;
}

function cloneSchema(schema: JsonSchema): JsonSchema {
  return JSON.parse(JSON.stringify(schema)) as JsonSchema;
}

function freezeJson<Value extends object>(value: Value): Value {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") freezeJson(child);
  }
  return Object.freeze(value);
}

function toAiSdkToolOutput(output: ApplicationToolResult | string | void) {
  if (typeof output === "string")
    return { type: "text" as const, value: output };
  if (output === undefined) return { type: "json" as const, value: null };
  return {
    type: output.isError ? ("error-json" as const) : ("json" as const),
    value: output as unknown as AiSdkJsonValue,
  };
}
