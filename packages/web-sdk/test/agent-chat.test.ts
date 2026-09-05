import { describe, expect, it, vi } from "vitest";
import {
  AgentConnectError,
  AgentSession,
  createAgentChat,
  defineTool,
  exportAgentChatMarkdown,
  type AgentProvider,
  type AgentProviderEvent,
  type AgentProviderTaskRequest,
} from "../src/index.js";

// Contract fixture for our event reducer, never an Omnigent compatibility model.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(
  turn: (
    request: AgentProviderTaskRequest,
  ) => AsyncIterable<AgentProviderEvent>,
  execute = vi.fn(async () => "tool-result"),
) {
  const requests: AgentProviderTaskRequest[] = [];
  const provider: AgentProvider = {
    streamTask(request) {
      requests.push(request);
      return turn(request);
    },
    submitToolResult: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const session = new AgentSession({
    provider,
    tools: [
      defineTool({
        name: "read",
        description: "Read",
        inputSchema: { type: "object", additionalProperties: false },
        execute,
      }),
    ],
  });
  return {
    provider,
    session,
    requests,
    execute,
    chat: createAgentChat({ session }),
  };
}

const complete = {
  type: "task.completed",
  continuationToken: "checkpoint",
} as const;
const call = {
  type: "tool.requested",
  actionId: "action",
  requestToken: "request",
  name: "read",
  arguments: {},
} as const;

describe("headless AgentChat public interface", () => {
  it("starts empty and supplies stable, deeply immutable ordered text/tool messages", async () => {
    const f = setup(async function* () {
      yield { type: "text.delta", delta: "Before " };
      yield { type: "text.delta", delta: "tool" };
      yield call;
      yield { type: "text.delta", delta: "After" };
      yield complete;
    });
    const empty = f.chat.getSnapshot();
    expect(f.chat.getSnapshot()).toBe(empty);
    expect(empty).toMatchObject({
      status: "idle",
      canSend: true,
      canStop: false,
      messages: [],
    });
    const seen = [empty];
    const unsubscribe = f.chat.subscribe(() => {
      seen.push(f.chat.getSnapshot());
    });
    const result = await f.chat.send("Explain this");
    expect(result.status).toBe("completed");
    expect(result.parts.map((part) => part.type)).toEqual([
      "text",
      "tool",
      "text",
    ]);
    expect(result.parts[0]).toMatchObject({ text: "Before tool" });
    expect(result.parts[1]).toMatchObject({
      status: "completed",
      actionId: "action",
    });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.provider.submitToolResult).toHaveBeenCalledOnce();
    expect(empty.messages).toEqual([]);
    const firstPartial = seen.find(
      (state) => state.messages.at(-1)?.parts[0]?.type === "text",
    )!;
    expect(firstPartial.messages.at(-1)?.parts[0]).toMatchObject({
      text: "Before ",
    });
    expect(() => {
      (result.parts as unknown[]).push("mutation");
    }).toThrow();
    const tool = result.parts[1]!;
    expect(tool.type === "tool" && Object.isFrozen(tool.arguments)).toBe(true);
    const count = seen.length;
    unsubscribe();
    await f.chat.send("Follow up");
    expect(seen).toHaveLength(count);
    expect(f.requests[1]).toMatchObject({
      prompt: "Follow up",
      continuationToken: "checkpoint",
    });
    expect(
      new Set(f.chat.getSnapshot().messages.map((message) => message.id)).size,
    ).toBe(4);
  });

  it("validates input and rejects overlap without adding phantom turns", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const f = setup(async function* () {
      entered.resolve();
      await gate.promise;
      yield complete;
    });
    await expect(f.chat.send("   ")).rejects.toThrow("empty");
    const pending = f.chat.send("first");
    await entered.promise;
    await expect(f.chat.send("second")).rejects.toMatchObject({
      code: "task_busy",
    });
    expect(f.chat.getSnapshot().messages).toHaveLength(2);
    gate.resolve();
    await pending;
  });

  it("retains partial text and typed errors, without pretending an admitted failure is resumable", async () => {
    const f = setup(async function* () {
      yield { type: "text.delta", delta: "Partial" };
      throw new AgentConnectError("session_expired", "Gone", {
        status: 401,
        manageUrl: "https://gateway.test/sessions",
      });
    });
    await expect(f.chat.send("first")).rejects.toMatchObject({
      code: "session_expired",
    });
    expect(f.chat.getSnapshot()).toMatchObject({
      status: "idle",
      canSend: false,
      needsNewSession: true,
      error: {
        code: "session_expired",
        status: 401,
        manageUrl: "https://gateway.test/sessions",
      },
    });
    expect(f.chat.getSnapshot().messages[1]).toMatchObject({
      status: "failed",
      parts: [{ text: "Partial" }],
    });
  });

  it("preserves known refusal retry and routes follow-ups without replaying the transcript", async () => {
    let refuse = true;
    const f = setup(async function* () {
      if (refuse)
        throw new AgentConnectError("task_busy", "Busy", { status: 409 });
      yield complete;
    });
    await expect(f.chat.send("first attempt")).rejects.toMatchObject({
      code: "task_busy",
    });
    expect(f.chat.getSnapshot().canSend).toBe(true);
    refuse = false;
    await f.chat.send("retry");
    refuse = true;
    await expect(f.chat.send("followup attempt")).rejects.toMatchObject({
      code: "task_busy",
    });
    expect(f.chat.getSnapshot().canSend).toBe(true);
    refuse = false;
    await f.chat.send("followup retry");
    expect(f.requests.map((request) => request.prompt)).toEqual([
      "first attempt",
      "retry",
      "followup attempt",
      "followup retry",
    ]);
    expect(f.requests[1]?.continuationToken).toBeUndefined();
    expect(f.requests[3]?.continuationToken).toBe("checkpoint");
  });

  it("handles tool failures and rejected calls without a preceding tool.requested", async () => {
    const execute = vi.fn(async () => {
      throw new Error("Handler broke");
    });
    const f = setup(async function* () {
      yield call;
      yield { ...call, actionId: "invalid", name: "unknown" };
      yield complete;
    }, execute);
    const result = await f.chat.send("test");
    expect(result.status).toBe("completed");
    expect(result.parts).toMatchObject([
      {
        type: "tool",
        status: "failed",
        error: { code: "tool_execution_failed" },
      },
      { type: "tool", status: "failed", error: { code: "unknown_tool" } },
    ]);
    expect(f.chat.getSnapshot().error).toBeUndefined();
  });

  it("reports unavailable continuation and supports attaching a completed session", async () => {
    const f = setup(async function* () {
      yield complete;
    });
    await f.session.runTask("earlier");
    const chat = createAgentChat({ session: f.session });
    await chat.send("next");
    expect(f.requests[1]?.continuationToken).toBe("checkpoint");
    const other = setup(async function* () {
      yield { type: "task.completed" };
    });
    await other.chat.send("only");
    expect(other.chat.getSnapshot()).toMatchObject({
      needsNewSession: true,
      canSend: false,
    });
    await expect(other.chat.send("no")).rejects.toMatchObject({
      code: "continuation_unavailable",
    });
  });

  it("stops immediately from a running-state subscriber before starting the provider", async () => {
    const f = setup(async function* () {
      yield complete;
    });
    let stopping: Promise<void> | undefined;
    f.chat.subscribe(() => {
      if (f.chat.getSnapshot().status === "running") stopping = f.chat.stop();
    });
    const result = await f.chat.send("never admitted");
    await stopping;
    expect(result.status).toBe("cancelled");
    expect(f.requests).toHaveLength(0);
    expect(f.chat.getSnapshot().canSend).toBe(true);
  });

  it("stops at tool notification without executing the tool and preserves truthful completion", async () => {
    const f = setup(async function* () {
      yield call;
      yield complete;
    });
    let stopping: Promise<void> | undefined;
    f.chat.subscribe(() => {
      if (
        f.chat.getSnapshot().canStop &&
        f.chat
          .getSnapshot()
          .messages.at(-1)
          ?.parts.some((part) => part.type === "tool")
      )
        stopping = f.chat.stop();
    });
    const result = await f.chat.send("stop before side effect");
    await stopping;
    expect(f.execute).not.toHaveBeenCalled();
    expect(result.status).toBe("completed"); // Fixture explicitly completed despite cancel.
    expect(result.parts[0]).toMatchObject({ status: "interrupted" });
  });

  it("coalesces stop while a local handler is pending and never submits its late output", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const execute = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return "late";
    });
    const f = setup(async function* () {
      yield call;
      yield { type: "task.cancelled" };
    }, execute);
    const pending = f.chat.send("pending");
    await entered.promise;
    const stop = f.chat.stop();
    expect(f.chat.stop()).toBe(stop);
    await stop;
    expect(f.chat.getSnapshot()).toMatchObject({
      status: "stopping",
      canSend: false,
    });
    release.resolve();
    expect((await pending).status).toBe("cancelled");
    expect(f.provider.submitToolResult).not.toHaveBeenCalled();
    expect(f.provider.cancel).toHaveBeenCalledOnce();
  });

  it("reports stop failures without releasing the turn or erasing a later success", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const f = setup(async function* () {
      yield { type: "text.delta", delta: "Thinking" };
      entered.resolve();
      await release.promise;
      yield complete;
    });
    vi.mocked(f.provider.cancel).mockRejectedValue(
      new Error("Interrupt unavailable"),
    );
    const pending = f.chat.send("work");
    await entered.promise;
    await expect(f.chat.stop()).rejects.toThrow("Interrupt unavailable");
    expect(f.chat.getSnapshot()).toMatchObject({
      canSend: false,
      error: { message: "Interrupt unavailable" },
    });
    release.resolve();
    expect((await pending).status).toBe("completed");
    expect(f.chat.getSnapshot().canSend).toBe(true);
  });

  it("isolates bad subscribers and disposes idempotently while draining quietly", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const f = setup(async function* () {
      entered.resolve();
      await release.promise;
      yield complete;
    });
    const onSubscriberError = vi.fn();
    const chat = createAgentChat({ session: f.session, onSubscriberError });
    chat.subscribe(() => {
      throw new Error("UI broke");
    });
    const listener = vi.fn();
    chat.subscribe(listener);
    const pending = chat.send("work");
    await entered.promise;
    expect(onSubscriberError).toHaveBeenCalled();
    const disposal = chat.dispose();
    expect(chat.dispose()).toBe(disposal);
    await disposal;
    const count = listener.mock.calls.length;
    await expect(chat.send("no")).rejects.toThrow("disposed");
    expect(() => chat.subscribe(listener)).toThrow("disposed");
    release.resolve();
    await pending;
    expect(listener).toHaveBeenCalledTimes(count);
    expect(chat.getSnapshot().status).toBe("disposed");
  });

  it("exports study notes without tool arguments by default, and labels incomplete turns", async () => {
    const f = setup(async function* () {
      yield { type: "text.delta", delta: "Explanation" };
      yield call;
      yield complete;
    });
    await f.chat.send("Question");
    expect(exportAgentChatMarkdown(f.chat.getSnapshot())).toBe(
      "## You\n\nQuestion\n\n## Assistant\n\nExplanation",
    );
    expect(
      exportAgentChatMarkdown(f.chat.getSnapshot(), {
        includeToolActivity: true,
      }),
    ).toContain('> Tool "read": completed');
    expect(
      exportAgentChatMarkdown(f.chat.getSnapshot(), {
        includeToolActivity: true,
      }),
    ).not.toContain("tool-result");
    expect(
      exportAgentChatMarkdown({
        ...f.chat.getSnapshot(),
        messages: [
          { id: "partial", role: "assistant", status: "cancelled", parts: [] },
        ],
      }),
    ).toContain("Turn status: cancelled");
  });
});
