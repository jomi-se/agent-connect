import {
  client,
  RequestError,
  type ClientConnection,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  AcpPairingError,
  createAcpPairing,
  type AcpPairingOptions,
  type AcpPairing,
} from "./acp-pairing.js";
import { AgentConnectError } from "./agent-session.js";
import { SingleMcpServer, McpOverAcpError } from "./single-mcp-server.js";
import {
  createResumableAcpStream,
  type ResumableAcpStream,
  type ResumableAcpStreamOptions,
} from "./resumable-acp-stream.js";
import type {
  AgentProvider,
  AgentProviderEvent,
  AgentProviderTaskRequest,
  AgentToolDefinition,
  ApplicationToolResult,
} from "./types.js";

/** @experimental Unstable ACP grant. Issuance/consent is an operator boundary. */
export interface AcpGrant {
  readonly gatewayUrl: string;
  readonly token: string;
}
/** @experimental Unstable ACP connection options. The gateway owns cwd/mode/model. */
export interface ConnectAgentOptions {
  /** Explicit headless grant compatibility. Browser applications should use pairing. */
  readonly grant?: AcpGrant;
  readonly gatewayUrl?: string;
  readonly pairing?: AcpPairingOptions;
  readonly tools: readonly AgentToolDefinition[];
  readonly sessionId?: string;
  readonly transport?: Omit<
    ResumableAcpStreamOptions,
    "token" | "tokenExpiresAt"
  >;
  readonly onSession?: (sessionId: string) => void;
  readonly onUpdate?: (
    notification: SessionNotification,
    replay: boolean,
  ) => void;
  readonly onRecovery?: (recovery: AcpRecovery) => void;
}
/** @experimental A load recovers history, never an uncertain application action. */
export interface AcpRecovery {
  readonly sessionId: string;
  readonly interrupted: boolean;
}
interface Pending {
  resolve(result: ApplicationToolResult): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setInterval>;
}
class Events implements AsyncIterable<AgentProviderEvent> {
  private values: AgentProviderEvent[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  private bytes = 0;
  constructor(private readonly overflow: () => void) {}
  push(value: AgentProviderEvent) {
    if (this.ended) return;
    this.bytes += new TextEncoder().encode(JSON.stringify(value)).length;
    if (this.values.length >= 8192 || this.bytes > 8 * 1024 * 1024) {
      this.values = [
        {
          type: "task.failed",
          code: "task_interrupted",
          message:
            "ACP event consumer overflow; uncertain turn was not re-sent",
        },
      ];
      this.ended = true;
      this.overflow();
    } else this.values.push(value);
    this.wake?.();
    this.wake = undefined;
  }
  end() {
    this.ended = true;
    this.wake?.();
    this.wake = undefined;
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.values.shift();
      if (next) {
        this.bytes -= new TextEncoder().encode(JSON.stringify(next)).length;
        yield next;
      } else if (this.ended) return;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}
interface Turn {
  readonly events: Events;
  readonly controller: AbortController;
  cancelled: boolean;
  finished: boolean;
  cancelTimer?: ReturnType<typeof setTimeout>;
}
const snapshot = (tools: readonly AgentToolDefinition[]) =>
  JSON.stringify(
    tools
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
// The pinned ACP SDK dispatches notification handlers through asynchronous
// middleware, while settling response promises immediately. Drain those
// microtasks before leaving replay mode or completing a turn.
const drainUpdates = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
function observe(callback: (() => void) | undefined) {
  try {
    callback?.();
  } catch {
    /* Observers cannot control an agent request. */
  }
}

/** @experimental ACP/MCP-over-ACP provider; neither extension is a stable API. */
export class AcpProvider implements AgentProvider {
  private readonly options: ConnectAgentOptions & { grant: AcpGrant };
  private readonly managed: AcpPairing | undefined;
  private readonly definitions: readonly AgentToolDefinition[];
  private connection!: ClientConnection;
  private link!: ResumableAcpStream;
  private active: Turn | undefined;
  private pending = new Map<string, Pending>();
  private id?: string;
  private loading = false;
  private stopped = false;
  private recovery: Promise<AcpRecovery> | undefined;
  private lastError: Error | undefined;
  private newSession: Promise<string> | undefined;
  private loadSupported = false;
  private server!: SingleMcpServer;
  private constructor(
    options: ConnectAgentOptions & { grant: AcpGrant },
    managed?: AcpPairing,
  ) {
    this.managed = managed;
    this.options = {
      ...options,
      grant: { ...options.grant },
      ...(options.transport ? { transport: { ...options.transport } } : {}),
    };
    this.definitions = structuredClone(
      options.tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    );
    if (
      new Set(this.definitions.map((t) => t.name)).size !==
      this.definitions.length
    )
      throw new TypeError("Duplicate ACP tool names");
    const url = new URL(options.grant.gatewayUrl);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password)
      throw new TypeError(
        "ACP grant requires a WebSocket URL without credentials",
      );
    if (!options.grant.token || !/^[A-Za-z0-9._~-]+$/.test(options.grant.token))
      throw new TypeError("Invalid ACP grant token");
  }
  static async connect(options: ConnectAgentOptions): Promise<AcpProvider> {
    options = {
      ...options,
      tools: structuredClone(
        options.tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      ),
    };
    if (options.grant && (options.gatewayUrl || options.pairing))
      throw new TypeError("Choose an explicit ACP grant or browser pairing");
    let managed: AcpPairing | undefined;
    let grant = options.grant;
    if (!grant) {
      if (!options.gatewayUrl)
        throw new TypeError("ACP connection requires gatewayUrl or a grant");
      managed = createAcpPairing({
        ...options.pairing,
        gatewayUrl: options.gatewayUrl,
        tools: options.tools,
      });
      try {
        // Open synchronously on an explicit popup action, before any await.
        if (options.pairing?.mode === "popup" && !options.pairing.callbackUrl)
          grant = await managed.pair("popup");
        else {
          try {
            grant = await managed.getGrant();
          } catch (error) {
            if (
              error instanceof AcpPairingError &&
              ["pairing_required", "expired", "invalid_grant"].includes(
                error.code,
              ) &&
              options.pairing?.mode === "redirect"
            )
              grant = await managed.pair("redirect");
            else throw error;
          }
        }
      } catch (error) {
        managed.dispose();
        throw error;
      }
    }
    const provider = new AcpProvider({ ...options, grant }, managed);
    try {
      await provider.open(options.sessionId);
      return provider;
    } catch (error) {
      const failure = provider.link?.error ?? error;
      provider.close();
      throw failure;
    }
  }
  get sessionId(): string | undefined {
    return this.id;
  }
  get transport(): ResumableAcpStream {
    return this.link;
  }
  private async open(loadId?: string) {
    this.server = new SingleMcpServer({
      serverId: "application-tools",
      name: "app",
      version: "0.1.0",
      tools: this.definitions.map((t) => ({
        ...t,
        execute: (args, ctx) => {
          if (!this.active || this.loading || this.active.cancelled)
            throw new AgentConnectError(
              "task_interrupted",
              "No active application turn",
            );
          if (!ctx.actionId)
            throw new AgentConnectError(
              "protocol_error",
              "Gateway omitted the stable application action ID",
            );
          const requestToken = ctx.actionId;
          if (this.pending.has(requestToken))
            throw new AgentConnectError(
              "protocol_error",
              "Duplicate application action ID",
            );
          return new Promise<ApplicationToolResult>((resolve, reject) => {
            const pending: Pending = { resolve, reject };
            const progressToken = ctx.meta?.["progressToken"];
            if (
              typeof progressToken === "string" ||
              typeof progressToken === "number"
            ) {
              let progress = 0;
              pending.timer = setInterval(() => {
                void this.connection.agent
                  .notify("mcp/message", {
                    connectionId: ctx.connectionId,
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress: ++progress,
                      message: "Waiting for application result",
                    },
                  })
                  .catch(() => {});
              }, 15000);
            }
            this.pending.set(requestToken, pending);
            this.active!.events.push({
              type: "tool.requested",
              requestToken,
              actionId: ctx.actionId!,
              name: t.name,
              arguments: args,
              signal: this.active!.controller.signal,
            });
          });
        },
      })),
    });
    const wrap = async <T>(fn: () => T | Promise<T>) => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof McpOverAcpError)
          throw new RequestError(error.code, error.message, error.data);
        throw error;
      }
    };
    this.link = createResumableAcpStream(this.options.grant.gatewayUrl, {
      ...this.options.transport,
      token: this.managed
        ? async () => (await this.managed!.getGrant(undefined)).token
        : this.options.grant.token,
      ...(this.managed
        ? { tokenExpiresAt: () => this.managed!.expiresAt }
        : {}),
      onState: (state, reason) => {
        if (state === "ended:unauthorized" || state === "ended:grant-revoked")
          void this.managed?.clear();
        observe(() => this.options.transport?.onState?.(state, reason));
      },
    });
    const app = client({ name: "agent-connect-web" })
      .onRequest(
        "mcp/connect",
        (p: unknown) => p as Parameters<SingleMcpServer["connect"]>[0],
        (ctx) => wrap(() => this.server.connect(ctx.params)),
      )
      .onRequest(
        "mcp/message",
        (p: unknown) => p as Parameters<SingleMcpServer["message"]>[0],
        (ctx) => wrap(() => this.server.message(ctx.params)),
      )
      .onRequest(
        "mcp/disconnect",
        (p: unknown) => p as Parameters<SingleMcpServer["disconnect"]>[0],
        (ctx) => wrap(() => this.server.disconnect(ctx.params)),
      )
      .onNotification(
        "mcp/message",
        (p: unknown) => p,
        () => {},
      )
      .onRequest("session/request_permission", () => ({
        outcome: { outcome: "cancelled" },
      }))
      .onNotification("session/update", (ctx) => this.update(ctx.params));
    const connection = app.connect(this.link.stream);
    this.connection = connection;
    void connection.closed.then(() => {
      if (
        this.connection !== connection ||
        this.stopped ||
        this.loading ||
        this.active
      )
        return;
      this.lastError =
        this.link.error ??
        new AgentConnectError("session_expired", "ACP connection ended");
      if (this.canRecover())
        void this.recover().catch((error) => {
          this.lastError =
            error instanceof Error ? error : new Error(String(error));
        });
    });
    const init = await connection.agent.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    this.loadSupported = init.agentCapabilities?.loadSession === true;
    if (loadId) {
      if (!this.loadSupported)
        throw new AgentConnectError(
          "continuation_unavailable",
          "Adapter does not support session/load",
        );
      this.loading = true;
      try {
        await connection.agent.request("session/load", {
          sessionId: loadId,
          cwd: ".",
          mcpServers: [this.server.descriptor],
        });
        await drainUpdates();
        this.setSession(loadId);
      } finally {
        this.loading = false;
      }
    }
    this.lastError = undefined;
  }
  private setSession(id: string) {
    this.id = id;
    observe(() => this.options.onSession?.(id));
  }
  private async ensureSession(): Promise<string> {
    if (this.id) return this.id;
    this.newSession ??= this.connection.agent
      .request("session/new", {
        cwd: ".",
        mcpServers: [this.server.descriptor],
      })
      .then((result) => {
        this.setSession(result.sessionId);
        return result.sessionId;
      })
      .catch((error: unknown) => {
        // A definite RPC rejection admits a new deliberate attempt. Malformed
        // responses (-32600) and transport failures may have created a session.
        if (error instanceof RequestError && error.code !== -32600)
          this.newSession = undefined;
        throw error;
      });
    return this.newSession;
  }
  private update(notification: SessionNotification) {
    if (this.id && notification.sessionId !== this.id) return;
    observe(() => this.options.onUpdate?.(notification, this.loading));
    if (this.loading || !this.active) return;
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text")
          this.active.events.push({
            type: "text.delta",
            delta: update.content.text,
          });
        break;
      case "agent_thought_chunk":
        if (update.content.type === "text")
          this.active.events.push({
            type: "thought.delta",
            delta: update.content.text,
          });
        break;
      case "plan":
        this.active.events.push({
          type: "plan.updated",
          entries: structuredClone(update.entries),
        });
        break;
      case "tool_call":
      case "tool_call_update":
        this.active.events.push({
          type: "tool.updated",
          toolCallId: update.toolCallId,
          ...(update.title != null ? { title: update.title } : {}),
          ...(update.status != null ? { status: update.status } : {}),
          ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
          ...(update.rawOutput !== undefined
            ? { output: update.rawOutput }
            : {}),
          ...(update.content != null
            ? { content: structuredClone(update.content) }
            : {}),
        });
        break;
    }
  }
  async *streamTask(
    request: AgentProviderTaskRequest,
  ): AsyncIterable<AgentProviderEvent> {
    if (this.stopped)
      throw new AgentConnectError("session_expired", "ACP provider is closed");
    if (this.active)
      throw new AgentConnectError(
        "task_busy",
        "One ACP prompt may run at a time",
      );
    if (snapshot(request.tools) !== snapshot(this.definitions))
      throw new AgentConnectError(
        "webmcp_snapshot_invalidated",
        "ACP tool snapshot is fixed at connection",
      );
    if (
      request.continuationToken !== undefined &&
      request.continuationToken !== this.id
    )
      throw new AgentConnectError(
        "continuation_unavailable",
        "Continuation belongs to another ACP session",
      );
    if (this.recovery) await this.recovery;
    if (this.active)
      throw new AgentConnectError(
        "task_busy",
        "One ACP prompt may run at a time",
      );
    if (this.lastError) throw this.lastError;
    const turn: Turn = {
      events: new Events(() => {
        this.connection.close();
        this.link.close();
      }),
      controller: new AbortController(),
      cancelled: false,
      finished: false,
    };
    this.active = turn;
    const execution = this.perform(request.prompt, turn);
    try {
      yield* turn.events;
      await execution;
    } finally {
      if (!turn.finished) {
        await this.cancel();
        await execution;
      }
    }
  }
  private async perform(prompt: string, turn: Turn) {
    try {
      const sessionId = await this.ensureSession();
      if (turn.cancelled) {
        turn.events.push({ type: "task.cancelled" });
        return;
      }
      turn.events.push({ type: "task.admitted" });
      const result = await this.connection.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      await drainUpdates();
      turn.events.push(
        turn.cancelled || result.stopReason === "cancelled"
          ? { type: "task.cancelled" }
          : { type: "task.completed", continuationToken: sessionId },
      );
    } catch (cause) {
      turn.controller.abort();
      const transportError = this.link.error;
      const error =
        transportError ??
        (cause instanceof AgentConnectError
          ? cause
          : new AgentConnectError(
              "agent_execution_failed",
              cause instanceof Error ? cause.message : String(cause),
            ));
      this.clearPending(error);
      if (this.canRecover()) {
        try {
          await this.recover(true);
          turn.events.push({
            type: "task.failed",
            code: "task_interrupted",
            message: "Interrupted turn was not re-sent; conversation loaded",
          });
        } catch (recoveryError) {
          this.lastError =
            recoveryError instanceof Error ? recoveryError : error;
          turn.events.push({
            type: "task.failed",
            code: "task_interrupted",
            message: `Interrupted turn was not re-sent; recovery failed: ${this.lastError.message}`,
          });
        }
      } else {
        turn.events.push(
          turn.cancelled
            ? { type: "task.cancelled" }
            : { type: "task.failed", code: error.code, message: error.message },
        );
      }
    } finally {
      turn.finished = true;
      turn.controller.abort();
      clearTimeout(turn.cancelTimer);
      this.clearPending(
        new AgentConnectError("task_interrupted", "ACP turn ended"),
      );
      turn.events.end();
      if (this.active === turn) this.active = undefined;
    }
  }
  async submitToolResult(
    requestToken: string,
    output: string,
    applicationResult?: ApplicationToolResult,
  ): Promise<void> {
    const pending = this.pending.get(requestToken);
    if (!pending)
      throw new AgentConnectError(
        "protocol_error",
        "Unknown or already settled ACP tool result",
      );
    // AgentProvider's existing contract returns a string: AgentSession flattens
    // text content and serializes structured data/errors. Preserve that contract.
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      parsed = undefined;
    }
    let result: ApplicationToolResult = {
      content: [{ type: "text", text: output }],
    };
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const value = parsed as Record<string, unknown>;
      if (Array.isArray(value["content"]))
        result = parsed as ApplicationToolResult;
      else if (
        typeof value["error"] === "string" &&
        typeof value["code"] === "string"
      )
        result = {
          content: [{ type: "text", text: value["error"] }],
          isError: true,
        };
      else
        result = {
          ...result,
          structuredContent: parsed as NonNullable<
            ApplicationToolResult["structuredContent"]
          >,
        };
    }
    clearInterval(pending.timer);
    this.pending.delete(requestToken);
    pending.resolve(applicationResult ?? result);
  }
  async cancel(): Promise<void> {
    if (!this.active || this.active.cancelled) return;
    this.active.cancelled = true;
    this.active.controller.abort();
    const turn = this.active;
    turn.cancelTimer = setTimeout(() => {
      if (this.active === turn) this.link.close();
    }, 30000);
    this.clearPending(
      new AgentConnectError("task_interrupted", "Application turn cancelled"),
    );
    if (this.id)
      await this.connection.agent.notify("session/cancel", {
        sessionId: this.id,
      });
  }
  private clearPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearInterval(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  private canRecover() {
    return (
      !!this.id &&
      !this.stopped &&
      !!this.link.error &&
      [4404, 4410, 4413].includes(this.link.error.closeCode)
    );
  }
  /** Load history on a new transport. Never replays a prompt or tool result. */
  recover(interrupted = false): Promise<AcpRecovery> {
    if (this.recovery) return this.recovery;
    if (
      this.link.error &&
      ![4404, 4410, 4413].includes(this.link.error.closeCode)
    )
      return Promise.reject(this.link.error);
    if (!this.id || this.stopped || (this.active && !interrupted))
      return Promise.reject(
        new AgentConnectError(
          "continuation_unavailable",
          "Recovery requires an idle known ACP session",
        ),
      );
    const sessionId = this.id;
    if (!this.link.error && this.link.stats().ended === null) {
      this.link.checkLiveness("ACP recover");
      return Promise.resolve({ sessionId, interrupted: false });
    }
    this.loading = true;
    this.connection.close();
    this.link.close();
    this.recovery = this.open(sessionId)
      .then(() => {
        const result = { sessionId, interrupted };
        observe(() => this.options.onRecovery?.(result));
        return result;
      })
      .catch((error: unknown) => {
        this.lastError =
          error instanceof Error ? error : new Error(String(error));
        // A live replacement transport is not a recovered conversation when
        // initialize/load rejected. End it so an explicit recovery retry loads
        // history again instead of treating the failed host as healthy idle.
        this.connection.close();
        this.link.close();
        throw this.lastError;
      })
      .finally(() => {
        this.recovery = undefined;
        this.loading = false;
      });
    return this.recovery;
  }
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearPending(
      new AgentConnectError("session_expired", "ACP provider closed"),
    );
    this.connection?.close();
    this.link?.close();
    this.managed?.dispose();
  }
}
/** @experimental Connect through browser consent or an explicit headless ACP grant. */
export function connectAgent(
  options: ConnectAgentOptions,
): Promise<AcpProvider> {
  return AcpProvider.connect(options);
}
