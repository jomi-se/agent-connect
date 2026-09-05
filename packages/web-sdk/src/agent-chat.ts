import { AgentConnectError, type AgentSession } from "./agent-session.js";
import type { AgentTaskEvent, JsonObject } from "./types.js";

export interface AgentChatError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly manageUrl?: string;
}

export interface AgentChatTextPart {
  readonly type: "text";
  readonly id: string;
  readonly text: string;
}

export interface AgentChatToolPart {
  readonly type: "tool";
  readonly id: string;
  readonly actionId: string;
  readonly name: string;
  readonly arguments?: JsonObject;
  readonly status: "running" | "completed" | "failed" | "interrupted";
  readonly error?: AgentChatError;
}

export type AgentChatPart = AgentChatTextPart | AgentChatToolPart;

export interface AgentChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly parts: readonly AgentChatPart[];
  readonly error?: AgentChatError;
}

export interface AgentChatSnapshot {
  readonly status: "idle" | "running" | "stopping" | "disposed";
  readonly messages: readonly AgentChatMessage[];
  readonly canSend: boolean;
  readonly canStop: boolean;
  /** A new explicitly connected session is needed; never silently reconnect. */
  readonly needsNewSession: boolean;
  /** Latest turn or stop-control error. A tool failure lives on its tool part. */
  readonly error?: AgentChatError;
}

export interface AgentChatOptions {
  /** Exclusive consumer: do not run this session elsewhere while attached. */
  readonly session: AgentSession;
  /** Subscriber failures are isolated from the agent loop. Defaults to console.error. */
  readonly onSubscriberError?: (error: unknown) => void;
}

export interface AgentChat {
  /** Stable reference until state changes; suitable for external-store bindings. */
  getSnapshot(): AgentChatSnapshot;
  /** Change notification only, not an immediate callback. Read getSnapshot first. */
  subscribe(listener: () => void): () => void;
  /** Resolves with a completed/cancelled assistant message; rejects on failure. */
  send(prompt: string): Promise<AgentChatMessage>;
  /** Requests cancellation; the transcript settles only when the stream settles. */
  stop(): Promise<void>;
  /** Detaches observers and requests stop, without revoking auth or deleting sessions. */
  dispose(): Promise<void>;
}

interface Turn {
  readonly messageId: string;
  started: boolean;
  stopPromise?: Promise<void>;
  cancelStarted: boolean;
  resolveStop?: () => void;
  rejectStop?: (error: unknown) => void;
}

/** In-memory conversation presentation over the existing session-owned tool loop. */
export function createAgentChat(options: AgentChatOptions): AgentChat {
  const { session } = options;
  const listeners = new Set<() => void>();
  const prefix = globalThis.crypto.randomUUID();
  let sequence = 0;
  const id = () => `${prefix}-${++sequence}`;
  let messages: readonly AgentChatMessage[] = Object.freeze([]);
  let active: Turn | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let error: AgentChatError | undefined;
  let snapshot = makeSnapshot();

  function makeSnapshot(): AgentChatSnapshot {
    const ready = session.canStartTask || session.canContinueTask;
    return Object.freeze({
      status: disposed
        ? "disposed"
        : active?.stopPromise
          ? "stopping"
          : active
            ? "running"
            : "idle",
      messages,
      canSend: !disposed && !active && ready,
      canStop: !disposed && !!active && !active.stopPromise,
      needsNewSession: !active && !ready,
      ...(error ? { error } : {}),
    });
  }

  function publish() {
    snapshot = makeSnapshot();
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener();
      } catch (cause) {
        try {
          (options.onSubscriberError ?? console.error)(cause);
        } catch {
          /* An error reporter must not own or interrupt the agent loop. */
        }
      }
    }
  }

  function replace(
    messageId: string,
    change: (message: AgentChatMessage) => AgentChatMessage,
  ) {
    messages = Object.freeze(
      messages.map((message) =>
        message.id === messageId ? freezeMessage(change(message)) : message,
      ),
    );
  }

  function finish(
    turn: Turn,
    status: AgentChatMessage["status"],
    failure?: AgentChatError,
  ) {
    replace(turn.messageId, (message) => ({
      ...message,
      status,
      parts: message.parts.map((part) =>
        part.type === "tool" && part.status === "running"
          ? Object.freeze({ ...part, status: "interrupted" as const })
          : part,
      ),
      ...(failure ? { error: failure } : {}),
    }));
  }

  function applyEvent(turn: Turn, event: AgentTaskEvent) {
    if (event.type === "task.started") {
      turn.started = true;
      if (turn.stopPromise) cancelNow(turn);
      return;
    }
    if (event.type === "task.completed") {
      // The final aggregate repeats the deltas. Do not append it a second time.
      finish(turn, "completed");
    } else if (event.type === "task.cancelled") {
      finish(turn, "cancelled");
    } else if (event.type === "task.failed") {
      throw new AgentConnectError(event.error.code, event.error.message);
    } else {
      replace(turn.messageId, (message) => {
        const parts = [...message.parts];
        if (event.type === "text.delta") {
          const last = parts.at(-1);
          if (last?.type === "text")
            parts[parts.length - 1] = Object.freeze({
              ...last,
              text: last.text + event.delta,
            });
          else
            parts.push(
              Object.freeze({ type: "text", id: id(), text: event.delta }),
            );
        } else if (event.type === "tool.requested") {
          parts.push(
            Object.freeze({
              type: "tool",
              id: id(),
              actionId: event.actionId,
              name: event.name,
              arguments: freezeJson(structuredClone(event.arguments)),
              status: "running",
            }),
          );
        } else {
          const index = parts.findIndex(
            (part) => part.type === "tool" && part.actionId === event.actionId,
          );
          const previous =
            index < 0 ? undefined : (parts[index] as AgentChatToolPart);
          const part: AgentChatToolPart = Object.freeze({
            ...(previous ?? {
              type: "tool",
              id: id(),
              actionId: event.actionId,
              name: event.name,
            }),
            status: event.isError ? "failed" : "completed",
            ...(event.error
              ? {
                  error: describeError(
                    new AgentConnectError(
                      event.error.code,
                      event.error.message,
                    ),
                  ),
                }
              : {}),
          });
          if (index < 0) parts.push(part);
          else parts[index] = part;
        }
        return { ...message, parts };
      });
    }
    publish();
  }

  function cancelNow(turn: Turn) {
    if (turn.cancelStarted) return;
    if (active !== turn) {
      turn.resolveStop?.();
      return;
    }
    turn.cancelStarted = true;
    // Invoke synchronously: a subscriber can stop at tool.requested before dispatch.
    let cancellation: Promise<void>;
    try {
      cancellation = session.cancel();
    } catch (cause) {
      cancellation = Promise.reject(cause);
    }
    void cancellation.then(
      () => turn.resolveStop?.(),
      (cause) => {
        if (active === turn) {
          error = describeError(cause);
          publish();
        }
        turn.rejectStop?.(cause);
      },
    );
  }

  function stop(): Promise<void> {
    const turn = active;
    if (!turn) return Promise.resolve();
    if (turn.stopPromise) return turn.stopPromise;
    turn.stopPromise = new Promise<void>((resolve, reject) => {
      turn.resolveStop = resolve;
      turn.rejectStop = reject;
    });
    publish();
    if (turn.started) cancelNow(turn);
    return turn.stopPromise;
  }

  async function consume(
    turn: Turn,
    prompt: string,
    initial: boolean,
  ): Promise<AgentChatMessage> {
    try {
      const stream = initial
        ? session.streamTask(prompt)
        : session.streamContinuation(prompt);
      for await (const event of stream) applyEvent(turn, event);
      return messages.find((message) => message.id === turn.messageId)!;
    } catch (cause) {
      error = describeError(cause);
      finish(turn, "failed", error);
      throw cause;
    } finally {
      active = undefined;
      // A failure before task.started has nothing to cancel.
      if (!turn.cancelStarted) turn.resolveStop?.();
      publish();
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) throw new Error("AgentChat is disposed");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send(prompt) {
      if (disposed) return Promise.reject(new Error("AgentChat is disposed"));
      if (typeof prompt !== "string" || !prompt.trim())
        return Promise.reject(new TypeError("Chat prompt must not be empty"));
      if (active)
        return Promise.reject(
          new AgentConnectError(
            "task_busy",
            "This conversation already has an active turn",
          ),
        );
      const initial = session.canStartTask;
      if (!initial && !session.canContinueTask)
        return Promise.reject(
          new AgentConnectError(
            "continuation_unavailable",
            "Connect a new session before sending another turn",
          ),
        );
      const turn: Turn = {
        messageId: id(),
        started: false,
        cancelStarted: false,
      };
      active = turn;
      error = undefined;
      messages = Object.freeze([
        ...messages,
        freezeMessage({
          id: id(),
          role: "user",
          status: "completed",
          parts: [{ type: "text", id: id(), text: prompt }],
        }),
        freezeMessage({
          id: turn.messageId,
          role: "assistant",
          status: "running",
          parts: [],
        }),
      ]);
      publish();
      return consume(turn, prompt, initial);
    },
    stop,
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      listeners.clear();
      disposal = stop();
      publish();
      return disposal;
    },
  };
}

function freezeMessage(message: AgentChatMessage): AgentChatMessage {
  return Object.freeze({
    ...message,
    parts: Object.freeze(message.parts.map((part) => Object.freeze(part))),
  });
}

function freezeJson(value: JsonObject): JsonObject {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") freezeJson(child as JsonObject);
  }
  return Object.freeze(value);
}

function describeError(cause: unknown): AgentChatError {
  return Object.freeze({
    name: cause instanceof Error ? cause.name : "Error",
    message: cause instanceof Error ? cause.message : "Chat operation failed",
    ...(cause instanceof AgentConnectError
      ? {
          code: cause.code,
          ...(cause.status !== undefined ? { status: cause.status } : {}),
          ...(cause.manageUrl !== undefined
            ? { manageUrl: cause.manageUrl }
            : {}),
        }
      : {}),
  });
}

/** Plain Markdown study-note export; never a provider checkpoint or replay format. */
export function exportAgentChatMarkdown(
  snapshot: AgentChatSnapshot,
  options: { readonly includeToolActivity?: boolean } = {},
): string {
  return snapshot.messages
    .map((message) => {
      const content = message.parts.flatMap((part) =>
        part.type === "text"
          ? [part.text]
          : options.includeToolActivity
            ? [`> Tool ${JSON.stringify(part.name)}: ${part.status}`]
            : [],
      );
      if (message.status !== "completed")
        content.push(`> Turn status: ${message.status}`);
      if (message.error)
        content.push(
          `> Error: ${message.error.message.replace(/\r?\n/g, " ")}`,
        );
      return `## ${message.role === "user" ? "You" : "Assistant"}\n\n${content.join("\n\n")}`;
    })
    .join("\n\n");
}
