import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { AcpToolExecutor } from "./acp-tool-executor.js";
import { AgentConnectError } from "./errors.js";
import type { AcpProvider } from "./acp-provider.js";
import type {
  AcpToolUpdate,
  AcpExecutionEvent,
  ApplicationTool,
} from "./types.js";

/** @experimental Unstable ACP ChatTransport options; application handlers belong to AcpToolExecutor. */
export interface AcpChatTransportOptions {
  readonly provider: AcpProvider;
  readonly tools: readonly ApplicationTool[];
}
/** @experimental Unstable ACP transport for AI SDK UI; the harness owns its tool loop. */
export interface AcpChatTransport extends ChatTransport<UIMessage> {
  /** Opaque association of this UI chat with its harness session. */
  readonly sessionId: string | undefined;
  /** Typed last streaming failure, retained when AI SDK projects errors as text. */
  readonly error: AgentConnectError | undefined;
  /** Dispose UI consumption; the provider's connection remains explicitly owned by the caller. */
  close(): Promise<void>;
}
interface ToolState {
  update: AcpToolUpdate;
  inputSent: boolean;
  outputSent: boolean;
}

/** @experimental ACP/MCP-over-ACP UI transport. Does not implement a LanguageModel. */
export function createAcpChatTransport(
  options: AcpChatTransportOptions,
): AcpChatTransport {
  const { provider, tools } = options;
  let session = new AcpToolExecutor({ provider, tools });
  let chatId: string | undefined;
  let active:
    | {
        stream: ReadableStream<UIMessageChunk>;
        iterator: AsyncIterator<AcpExecutionEvent>;
        abort: () => Promise<void>;
        cleanup: () => void;
      }
    | undefined;
  let disposed = false;
  let lastError: AgentConnectError | undefined;
  function bind(id: string) {
    if (!id)
      throw new AgentConnectError("protocol_error", "AI chatId is required");
    if (chatId !== undefined && chatId !== id)
      throw new AgentConnectError(
        "continuation_unavailable",
        "One AI chat is bound to this ACP provider",
      );
    chatId = id;
  }
  function requireOpen() {
    if (disposed)
      throw new AgentConnectError(
        "session_expired",
        "ACP chat transport is closed",
      );
  }
  return {
    get sessionId() {
      return provider.sessionId;
    },
    get error() {
      return lastError;
    },
    async sendMessages(request) {
      requireOpen();
      if (request.trigger === "regenerate-message")
        throw new AgentConnectError(
          "protocol_error",
          "ACP cannot regenerate or truncate an existing harness conversation",
        );
      if (active)
        throw new AgentConnectError(
          "task_busy",
          "One AI chat prompt may run at a time",
        );
      const last = request.messages.at(-1);
      if (
        !last ||
        last.role !== "user" ||
        last.parts.some((part) => part.type !== "text")
      )
        throw new AgentConnectError(
          "protocol_error",
          "ACP chat accepts an explicit last user message containing text only",
        );
      const prompt = last.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
      if (!prompt.trim())
        throw new AgentConnectError(
          "protocol_error",
          "ACP chat requires a non-empty user prompt",
        );
      bind(request.chatId);
      lastError = undefined;
      if (!session.canStartTask && !session.canContinueTask) {
        // A recovered interrupted/cancelled conversation can receive a deliberate
        // new user prompt. It never retries the last message from AI history.
        session = new AcpToolExecutor({ provider, tools });
      }
      const iterator = (
        session.canContinueTask
          ? session.streamContinuation(prompt)
          : session.streamTask(prompt)
      )[Symbol.asyncIterator]();
      const chunks: UIMessageChunk[] = [
        { type: "start", messageId: crypto.randomUUID() },
      ];
      const toolStates = new Map<string, ToolState>();
      let sequence = 0,
        textId: string | undefined,
        thoughtId: string | undefined,
        ended = false,
        cancelled = false,
        started = false;
      const closeParts = () => {
        if (textId) {
          chunks.push({ type: "text-end", id: textId });
          textId = undefined;
        }
        if (thoughtId) {
          chunks.push({ type: "reasoning-end", id: thoughtId });
          thoughtId = undefined;
        }
      };
      const abort = async () => {
        if (ended || cancelled) return;
        cancelled = true;
        await session.cancel();
      };
      const onAbort = () => {
        void abort().catch(() => {});
      };
      request.abortSignal?.addEventListener("abort", onAbort, { once: true });
      function map(event: AcpExecutionEvent) {
        switch (event.type) {
          case "text.delta":
            if (thoughtId) {
              chunks.push({ type: "reasoning-end", id: thoughtId });
              thoughtId = undefined;
            }
            if (!textId) {
              textId = `text-${++sequence}`;
              chunks.push({ type: "text-start", id: textId });
            }
            chunks.push({ type: "text-delta", id: textId, delta: event.delta });
            break;
          case "thought.delta":
            if (textId) {
              chunks.push({ type: "text-end", id: textId });
              textId = undefined;
            }
            if (!thoughtId) {
              thoughtId = `thought-${++sequence}`;
              chunks.push({ type: "reasoning-start", id: thoughtId });
            }
            chunks.push({
              type: "reasoning-delta",
              id: thoughtId,
              delta: event.delta,
            });
            break;
          case "plan.updated":
            chunks.push({
              type: "data-acp-plan",
              id: "acp-plan",
              data: event.entries,
            });
            break;
          case "tool.updated": {
            closeParts();
            let state = toolStates.get(event.toolCallId);
            if (!state) {
              state = { update: event, inputSent: false, outputSent: false };
              toolStates.set(event.toolCallId, state);
            } else state.update = { ...state.update, ...event };
            const update = state.update;
            chunks.push({
              type: "data-acp-tool",
              id: `acp-tool-${event.toolCallId}`,
              data: update,
            });
            const terminal =
              update.status === "completed" || update.status === "failed";
            if (!state.inputSent && (update.input !== undefined || terminal)) {
              chunks.push({
                type: "tool-input-available",
                toolCallId: update.toolCallId,
                toolName: update.title ?? "agent-tool",
                input: update.input ?? {},
                dynamic: true,
                providerExecuted: true,
                ...(update.title ? { title: update.title } : {}),
              });
              state.inputSent = true;
            }
            if (terminal && !state.outputSent) {
              chunks.push(
                update.status === "failed"
                  ? {
                      type: "tool-output-error",
                      toolCallId: update.toolCallId,
                      errorText:
                        typeof update.output === "string"
                          ? update.output
                          : "Harness tool failed",
                      dynamic: true,
                      providerExecuted: true,
                    }
                  : {
                      type: "tool-output-available",
                      toolCallId: update.toolCallId,
                      output: update.output ?? {
                        content: update.content ?? [],
                      },
                      dynamic: true,
                      providerExecuted: true,
                    },
              );
              state.outputSent = true;
            }
            break;
          }
          // AcpToolExecutor executes approved application handlers and returns MCP
          // results. ACP native progress above supplies the UI tool parts; do
          // not add a second AI SDK execute/onToolCall loop or duplicate IDs.
          case "tool.requested":
          case "tool.completed":
          case "task.started":
            break;
          case "task.completed":
            closeParts();
            chunks.push(
              cancelled
                ? { type: "abort", reason: "User cancelled" }
                : { type: "finish", finishReason: "stop" },
            );
            ended = true;
            break;
          case "task.cancelled":
            closeParts();
            chunks.push({ type: "abort", reason: "User cancelled" });
            ended = true;
            break;
          case "task.failed":
            lastError = new AgentConnectError(
              event.error.code,
              event.error.message,
            );
            closeParts();
            chunks.push({
              type: "error",
              errorText: `${event.error.code}: ${event.error.message}`,
            });
            ended = true;
            break;
        }
      }
      const cleanup = () => {
        request.abortSignal?.removeEventListener("abort", onAbort);
        if (active?.iterator === iterator) active = undefined;
      };
      const stream = new ReadableStream<UIMessageChunk>({
        async pull(controller) {
          try {
            while (chunks.length === 0 && !ended) {
              const next = await iterator.next();
              started = true;
              if (cancelled) await session.cancel();
              if (next.done) {
                closeParts();
                chunks.push(
                  cancelled
                    ? { type: "abort", reason: "User cancelled" }
                    : {
                        type: "error",
                        errorText: "ACP turn ended without a terminal event",
                      },
                );
                ended = true;
              } else map(next.value);
            }
            const next = chunks.shift();
            const terminal = ended && chunks.length === 0;
            if (terminal) {
              await iterator.return?.(undefined);
              cleanup();
            }
            if (next) controller.enqueue(next);
            if (terminal) controller.close();
          } catch (error) {
            lastError =
              error instanceof AgentConnectError
                ? error
                : new AgentConnectError(
                    "protocol_error",
                    error instanceof Error ? error.message : String(error),
                    { cause: error },
                  );
            closeParts();
            chunks.push({
              type: "error",
              errorText: error instanceof Error ? error.message : String(error),
            });
            ended = true;
            for (const chunk of chunks.splice(0)) controller.enqueue(chunk);
            cleanup();
            controller.close();
          }
        },
        async cancel() {
          try {
            await abort();
            await iterator.return?.(undefined);
          } finally {
            cleanup();
          }
        },
      });
      active = { stream, iterator, abort, cleanup };
      if (request.abortSignal?.aborted) {
        cancelled = true;
        if (started) await session.cancel();
      }
      return stream;
    },
    async reconnectToStream(request) {
      requireOpen();
      bind(request.chatId);
      if (request.abortSignal?.aborted) return null;
      if (active) {
        provider.transport.checkLiveness("AI SDK reconnect");
        if (active.stream.locked)
          throw new AgentConnectError(
            "task_busy",
            "The active UI stream already has a reader",
          );
        return active.stream;
      }
      // Healthy idle connections keep their live host; ended transports may
      // restore history through session/load, without fabricating a UI stream.
      if (provider.sessionId) await provider.recover();
      return null;
    },
    async close() {
      if (disposed) return;
      disposed = true;
      const current = active;
      if (current) {
        try {
          await current.abort();
        } catch {}
        try {
          await current.iterator.return?.(undefined);
        } catch {}
        current.cleanup();
      }
    },
  };
}
