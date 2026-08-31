import { AgentConnectError, AgentSession } from "./agent-session.js";
import { ResponsesProvider } from "./responses-provider.js";
import type {
  AgentConnection,
  AgentConnectErrorCode,
  ApplicationTool,
  ConnectAgentOptions,
  JsonObject,
} from "./types.js";

interface CreateSessionResponse {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly toolHash: string;
}

/**
 * Connect to an authorized Agent Connect gateway and create or recover a harness-neutral
 * application session. Provider session identifiers remain gateway-internal.
 */
export async function connectAgent(
  options: ConnectAgentOptions,
): Promise<AgentConnection> {
  if (options.baseUrl.trim().length === 0) {
    throw new TypeError("Agent Connect baseUrl must not be empty");
  }
  if (options.appId.trim().length === 0) {
    throw new TypeError("Agent Connect appId must not be empty");
  }
  if (options.tools.length === 0) {
    throw new TypeError("Agent Connect requires at least one application tool");
  }
  if (options.accessToken.trim().length === 0) {
    throw new TypeError("An application grant accessToken is required");
  }

  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const tools = snapshotTools(options.tools);
  const fetchImplementation =
    options.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImplementation(`${baseUrl}/v1/app-sessions`, {
    method: "POST",
    headers: {
      ...options.headers,
      Authorization: `Bearer ${options.accessToken}`,
      "Content-Type": "application/json",
    },
    credentials: options.credentials ?? "same-origin",
    body: JSON.stringify({
      appId: options.appId,
      ...(options.freshSession ? { fresh: true } : {}),
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    const failure = responseFailure(body);
    throw new AgentConnectError(
      sessionFailureCode(response.status, failure.error),
      `Failed to create Agent Connect session: HTTP ${response.status}${body ? ` — ${body}` : ""}`,
      {
        status: response.status,
        ...(failure.manageUrl ? { manageUrl: failure.manageUrl } : {}),
      },
    );
  }
  const created = parseCreateResponse(await response.json());
  const providerHeaders = {
    ...options.headers,
    Authorization: `Bearer ${created.accessToken}`,
  };
  const session = new AgentSession({
    provider: new ResponsesProvider({
      baseUrl,
      fetch: fetchImplementation,
      headers: providerHeaders,
      ...(options.credentials ? { credentials: options.credentials } : {}),
    }),
    tools,
  });
  return {
    session,
    sessionId: created.sessionId,
    accessToken: created.accessToken,
    expiresAt: created.expiresAt,
    toolHash: created.toolHash,
  };
}

/**
 * Distinguishes the refusals an application can act on. `session_capacity` is
 * retryable and has a page that resolves it; `session_expired` means the
 * session is gone and a new one must be created, rather than a token refreshed.
 */
function sessionFailureCode(
  status: number,
  error: string | undefined,
): AgentConnectErrorCode {
  if (status === 401 && error === "invalid_app_grant")
    return "invalid_app_grant";
  if (status === 401 && error === "session_expired") return "session_expired";
  if (status === 429 && error === "session_capacity") return "session_capacity";
  return "http_error";
}

function responseFailure(body: string): {
  readonly error: string | undefined;
  readonly manageUrl: string | undefined;
} {
  try {
    const parsed = JSON.parse(body) as {
      readonly error?: unknown;
      readonly manageUrl?: unknown;
    };
    return {
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      manageUrl:
        typeof parsed.manageUrl === "string" ? parsed.manageUrl : undefined,
    };
  } catch {
    return { error: undefined, manageUrl: undefined };
  }
}

function snapshotTools(
  tools: readonly ApplicationTool[],
): readonly ApplicationTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as JsonObject,
    execute: tool.execute.bind(tool),
  }));
}

function parseCreateResponse(value: unknown): CreateSessionResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>)["sessionId"] !== "string" ||
    typeof (value as Record<string, unknown>)["accessToken"] !== "string" ||
    typeof (value as Record<string, unknown>)["expiresAt"] !== "string" ||
    typeof (value as Record<string, unknown>)["toolHash"] !== "string"
  ) {
    throw new AgentConnectError(
      "protocol_error",
      "Gateway returned an invalid application session",
    );
  }
  return value as CreateSessionResponse;
}
