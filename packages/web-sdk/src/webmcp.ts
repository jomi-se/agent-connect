import { AgentConnectError } from "./agent-session.js";
import { Ajv } from "ajv";
import type { ApplicationTool, JsonObject, JsonSchema } from "./types.js";

/** Experimental native Chromium WebMCP snapshot; not a browser polyfill. */
export interface WebMcpToolSnapshot {
  readonly tools: readonly ApplicationTool[];
  /** Aborted on toolchange, page exit, caller abort, or disposal. */
  readonly signal: AbortSignal;
  /** Releases listeners and requests cancellation of pending local executions. */
  dispose(): void;
}

export interface WebMcpToolSnapshotOptions {
  readonly document?: Document;
  /** Omit to include all tools owned by this document, excluding frames. */
  readonly toolNames?: readonly string[];
  /** Bind to the application's connection lifetime, if it has one. */
  readonly signal?: AbortSignal;
}

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: string;
  readonly window: Window;
  readonly origin: string;
}

interface ChromiumModelContext extends EventTarget {
  getTools(): Promise<RegisteredTool[]>;
  executeTool(
    tool: RegisteredTool,
    inputArguments: string,
    options: { signal: AbortSignal },
  ): Promise<string>;
}

/**
 * Discover tools before consent, then pass `.tools` to beginAgentAuthorization
 * and connectAgent. Validated with Chrome 153's native JSON-string binding.
 * The current CG draft uses objects instead; do not auto-retry an invocation
 * in a second format, because the first call may already have side effects.
 * Any observed registry change invalidates this snapshot rather than expanding
 * authority. Native WebMCP does not guarantee immutable registration identity.
 */
export async function createWebMcpToolSnapshot(
  options: WebMcpToolSnapshotOptions = {},
): Promise<WebMcpToolSnapshot> {
  const owner = options.document ?? globalThis.document;
  const window = owner?.defaultView;
  const context =
    window &&
    (
      owner as
        | (Document & {
            modelContext?: ChromiumModelContext;
          })
        | undefined
    )?.modelContext;
  if (
    !window ||
    !context ||
    typeof context.getTools !== "function" ||
    typeof context.executeTool !== "function" ||
    typeof context.addEventListener !== "function" ||
    typeof context.removeEventListener !== "function"
  ) {
    throw new AgentConnectError(
      "webmcp_unavailable",
      "Native document.modelContext discovery and execution are required",
    );
  }

  const controller = new AbortController();
  const dispose = () => {
    context.removeEventListener("toolchange", dispose);
    window.removeEventListener("pagehide", dispose);
    options.signal?.removeEventListener("abort", dispose);
    controller.abort();
  };
  const assertActive = () => {
    if (controller.signal.aborted || window.document !== owner) {
      dispose();
      throw new AgentConnectError(
        "webmcp_snapshot_invalidated",
        "WebMCP tools changed or the snapshot ended; rediscover tools and reconnect",
      );
    }
  };
  context.addEventListener("toolchange", dispose);
  window.addEventListener("pagehide", dispose);
  options.signal?.addEventListener("abort", dispose, { once: true });
  if (options.signal?.aborted) dispose();

  try {
    assertActive();
    const discovered = await context.getTools();
    assertActive();
    const local = discovered.filter(
      (tool) => tool.window === window && tool.origin === owner.location.origin,
    );
    const requested = options.toolNames;
    if (requested && new Set(requested).size !== requested.length) {
      throw new TypeError("Duplicate requested WebMCP tool name");
    }
    if (requested?.some((name) => !local.some((tool) => tool.name === name))) {
      throw new TypeError(
        "Requested WebMCP tool is not owned by this document",
      );
    }
    const selected = local.filter(
      (tool) => !requested || requested.includes(tool.name),
    );
    if (selected.length === 0) throw new TypeError("No WebMCP tools selected");
    const ajv = new Ajv({ strict: false });
    const names = new Set<string>();
    const tools = selected.map((tool): ApplicationTool => {
      if (
        !tool.name?.trim() ||
        !tool.description?.trim() ||
        names.has(tool.name)
      ) {
        throw new TypeError("Invalid or duplicate WebMCP tool definition");
      }
      names.add(tool.name);
      // Chrome returns JSON text here. Refuse other bindings before approval.
      if (
        tool.inputSchema !== undefined &&
        typeof tool.inputSchema !== "string"
      ) {
        throw new AgentConnectError(
          "webmcp_unavailable",
          "Unsupported WebMCP schema binding; expected Chromium JSON text",
        );
      }
      const inputSchema: unknown = JSON.parse(
        tool.inputSchema ?? '{"type":"object"}',
      );
      if (
        !inputSchema ||
        typeof inputSchema !== "object" ||
        Array.isArray(inputSchema)
      ) {
        throw new TypeError("WebMCP input schema must describe an object");
      }
      const schema = inputSchema as JsonSchema;
      if (
        (schema.type !== undefined && schema.type !== "object") ||
        !ajv.validateSchema(schema)
      ) {
        throw new TypeError("Invalid WebMCP object input schema");
      }
      // Match AgentSession's compiler before disclosing a candidate to consent.
      ajv.compile(schema);
      freezeJson(inputSchema);
      const handle = Object.freeze({ ...tool });
      return Object.freeze({
        name: tool.name,
        description: tool.description,
        inputSchema: inputSchema as JsonSchema,
        async execute(arguments_: JsonObject) {
          assertActive();
          const result = await context.executeTool(
            handle,
            JSON.stringify(arguments_),
            {
              signal: controller.signal,
            },
          );
          if (typeof result !== "string") {
            throw new TypeError(
              "Unsupported WebMCP result binding; expected string",
            );
          }
          return result;
        },
      });
    });
    return Object.freeze({
      tools: Object.freeze(tools),
      signal: controller.signal,
      dispose,
    });
  } catch (cause) {
    dispose();
    throw cause;
  }
}

function freezeJson(value: object): void {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") freezeJson(child);
  }
  Object.freeze(value);
}
