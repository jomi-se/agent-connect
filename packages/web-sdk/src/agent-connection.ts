import { AgentConnectError, AgentSession } from "./agent-session.js";
import { ResponsesProvider } from "./responses-provider.js";
import type {
  AgentConnection,
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
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    const code =
      response.status === 401 && responseError(body) === "invalid_app_grant"
        ? "invalid_app_grant"
        : "http_error";
    throw new AgentConnectError(
      code,
      `Failed to create Agent Connect session: HTTP ${response.status}${body ? ` — ${body}` : ""}`,
      { status: response.status },
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

function responseError(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { readonly error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
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
