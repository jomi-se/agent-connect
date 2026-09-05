import { describe, expect, it, vi } from "vitest";

import {
  AgentConnectError,
  AgentSession,
  defineTool,
  type AgentProvider,
  type AgentProviderEvent,
  type AgentProviderTaskRequest,
  type ApplicationToolHandler,
} from "../src/index.js";

class FakeProvider implements AgentProvider {
  readonly requests: AgentProviderTaskRequest[] = [];
  readonly results: Array<{ token: string; output: string }> = [];
  cancelled = false;

  constructor(private readonly events: readonly AgentProviderEvent[]) {}

  async *streamTask(
    request: AgentProviderTaskRequest,
  ): AsyncGenerator<AgentProviderEvent> {
    this.requests.push(request);
    for (const event of this.events) {
      yield event;
    }
  }

  async submitToolResult(token: string, output: string): Promise<void> {
    this.results.push({ token, output });
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

function nonceTool(
  execute: ApplicationToolHandler<{ readonly prefix: string }> = vi.fn(
    () => "fresh-nonce",
  ),
) {
  return defineTool({
    name: "get_nonce",
    description: "Return the browser nonce",
    inputSchema: {
      type: "object",
      properties: { prefix: { type: "string" } },
      required: ["prefix"],
      additionalProperties: false,
    },
    execute,
  });
}

/** Refuses a turn the way the gateway does when nothing was admitted. */
class RefusingProvider implements AgentProvider {
  readonly requests: AgentProviderTaskRequest[] = [];
  refuse = false;

  constructor(private readonly events: readonly AgentProviderEvent[]) {}

  async *streamTask(
    request: AgentProviderTaskRequest,
  ): AsyncGenerator<AgentProviderEvent> {
    this.requests.push(request);
    if (this.refuse) {
      throw new AgentConnectError(
        "task_busy",
        "this application session already has an active response chain",
      );
    }
    for (const event of this.events) {
      yield event;
    }
  }

  async submitToolResult(): Promise<void> {}

  async cancel(): Promise<void> {}
}

describe("AgentSession", () => {
  it("retries known initial refusals and guards concurrent consumption", async () => {
    const provider = new RefusingProvider([
      { type: "task.completed", continuationToken: "head" },
    ]);
    const session = new AgentSession({ provider, tools: [nonceTool()] });
    provider.refuse = true;
    await expect(session.runTask("first")).rejects.toMatchObject({
      code: "task_busy",
    });
    expect(session.canStartTask).toBe(true);
    provider.refuse = false;
    const stream = session.streamTask("first");
    await stream.next();
    expect(session.canStartTask).toBe(false);
    expect(session.canContinueTask).toBe(false);
    await expect(session.runTask("overlap")).rejects.toMatchObject({
      code: "task_busy",
    });
    for await (const _event of stream) {
      /* drain */
    }
    expect(session.canContinueTask).toBe(true);
  });

  it("cancels before provider admission without consuming the initial turn", async () => {
    const provider = new FakeProvider([]);
    const session = new AgentSession({ provider, tools: [nonceTool()] });
    const stream = session.streamTask("first");
    await stream.next();
    await session.cancel();
    expect((await stream.next()).value).toEqual({ type: "task.cancelled" });
    await stream.next();
    expect(provider.requests).toEqual([]);
    expect(session.canStartTask).toBe(true);
  });

  it("does not execute a tool stopped at its request notification", async () => {
    const execute = vi.fn(() => "result");
    const provider = new FakeProvider([
      {
        type: "tool.requested",
        requestToken: "call",
        actionId: "action",
        name: "get_nonce",
        arguments: { prefix: "x" },
      },
      { type: "task.cancelled" },
    ]);
    const session = new AgentSession({ provider, tools: [nonceTool(execute)] });
    const stream = session.streamTask("first");
    await stream.next();
    await stream.next();
    await session.cancel();
    expect((await stream.next()).value).toMatchObject({
      type: "task.cancelled",
    });
    await stream.next();
    expect(execute).not.toHaveBeenCalled();
    expect(provider.results).toEqual([]);
  });

  it("coalesces failed cancellation without overriding later completion", async () => {
    const provider = new FakeProvider([
      { type: "text.delta", delta: "done" },
      { type: "task.completed", continuationToken: "head" },
    ]);
    const cancel = vi
      .spyOn(provider, "cancel")
      .mockRejectedValue(new Error("control failed"));
    const session = new AgentSession({ provider, tools: [nonceTool()] });
    const stream = session.streamTask("first");
    await stream.next();
    await stream.next();
    const first = session.cancel();
    expect(session.cancel()).toBe(first);
    await expect(first).rejects.toThrow("control failed");
    expect(session.canContinueTask).toBe(false);
    expect((await stream.next()).value).toEqual({
      type: "task.completed",
      text: "done",
    });
    await stream.next();
    expect(session.canContinueTask).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("signals pending tools and drops late output without inventing cancellation", async () => {
    let resolve!: (value: string) => void;
    let entered!: () => void;
    const running = new Promise<void>((done) => {
      entered = done;
    });
    let signal: AbortSignal | undefined;
    const provider = new FakeProvider([
      {
        type: "tool.requested",
        requestToken: "call",
        actionId: "action",
        name: "get_nonce",
        arguments: { prefix: "x" },
      },
      { type: "task.completed", continuationToken: "head" },
    ]);
    const session = new AgentSession({
      provider,
      tools: [
        nonceTool((_args, context) => {
          signal = context.signal;
          entered();
          return new Promise<string>((done) => {
            resolve = done;
          });
        }),
      ],
    });
    const result = session.runTask("first");
    await running;
    await session.cancel();
    expect(signal?.aborted).toBe(true);
    resolve("late");
    await expect(result).resolves.toEqual({ text: "" });
    expect(provider.results).toEqual([]);
    expect(session.canContinueTask).toBe(true);
  });
  it("keeps the continuation checkpoint when a turn is refused before admission", async () => {
    const provider = new RefusingProvider([
      { type: "text.delta", delta: "done" },
      { type: "task.completed", continuationToken: "resp_first" },
    ]);
    const session = new AgentSession({
      createSessionId: () => "acs_test",
      provider,
      tools: [nonceTool()],
    });
    await session.runTask("first");

    // A refusal that admitted nothing leaves the previous turn as the session
    // head, so the checkpoint must survive it. Clearing on the attempt rather
    // than on admission stranded the session: the head was still continuable,
    // but the application no longer held the token naming it.
    provider.refuse = true;
    await expect(session.continueTask("second")).rejects.toThrow(
      AgentConnectError,
    );

    provider.refuse = false;
    const retried = await session.continueTask("second");
    expect(retried.text).toBe("done");
    expect(provider.requests.at(-1)?.continuationToken).toBe("resp_first");
  });

  it("discards the continuation checkpoint once a turn has been admitted", async () => {
    const provider = new RefusingProvider([
      { type: "text.delta", delta: "done" },
      { type: "task.completed", continuationToken: "resp_first" },
    ]);
    const session = new AgentSession({
      createSessionId: () => "acs_test",
      provider,
      tools: [nonceTool()],
    });
    await session.runTask("first");

    // An admitted turn makes the older head unusable, even when the turn then
    // ends without publishing a new checkpoint of its own. `task.started` is
    // emitted before the provider is called, so the turn is only admitted once
    // the provider's own first event arrives.
    const stream = session.streamContinuation("second");
    expect(await stream.next()).toMatchObject({
      value: { type: "task.started" },
    });
    expect(await stream.next()).toMatchObject({
      value: { type: "text.delta" },
    });
    await stream.return(undefined);

    await expect(session.continueTask("third")).rejects.toThrow(
      /No successfully completed task/,
    );
  });

  it("uses a fixed tool snapshot and suppresses repeated action IDs", async () => {
    const execute = vi.fn(
      ({ prefix }: { readonly prefix: string }) => `${prefix}-nonce`,
    );
    const tool = nonceTool(execute);
    const provider = new FakeProvider([
      {
        type: "tool.requested",
        requestToken: "opaque-1",
        actionId: "action-1",
        name: "get_nonce",
        arguments: { prefix: "browser" },
      },
      {
        type: "tool.requested",
        requestToken: "opaque-1-duplicate",
        actionId: "action-1",
        name: "get_nonce",
        arguments: { prefix: "browser" },
      },
      { type: "text.delta", delta: "browser-nonce" },
      { type: "task.completed" },
    ]);
    const session = new AgentSession({
      provider,
      tools: [tool],
      createSessionId: () => "public-session",
    });

    const stream = session.streamTask("Get the nonce")[Symbol.asyncIterator]();
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: "task.started" },
    });
    (tool.inputSchema as { required: string[] }).required.push("later");

    const events = [];
    while (true) {
      const next = await stream.next();
      if (next.done) break;
      events.push(next.value);
    }

    expect(provider.requests[0]?.tools).toEqual([
      {
        name: "get_nonce",
        description: "Return the browser nonce",
        inputSchema: {
          type: "object",
          properties: { prefix: { type: "string" } },
          required: ["prefix"],
          additionalProperties: false,
        },
      },
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      { prefix: "browser" },
      {
        connectionId: "public-session",
        signal: expect.any(AbortSignal),
        toolName: "get_nonce",
        meta: null,
        actionId: "action-1",
      },
    );
    expect(provider.results).toEqual([
      { token: "opaque-1", output: "browser-nonce" },
    ]);
    expect(events).toContainEqual({
      type: "task.completed",
      text: "browser-nonce",
    });
  });

  it.each([
    ["missing required property", {}],
    ["wrong property type", { prefix: 42 }],
    ["forbidden extra property", { prefix: "x", extra: true }],
  ])("rejects %s before invoking a tool", async (_label, arguments_) => {
    const execute = vi.fn(() => "must-not-run");
    const provider = new FakeProvider([
      {
        type: "tool.requested",
        requestToken: "opaque-invalid",
        actionId: "action-invalid",
        name: "get_nonce",
        arguments: arguments_,
      },
      { type: "task.completed" },
    ]);
    const session = new AgentSession({ provider, tools: [nonceTool(execute)] });

    const events = [];
    for await (const event of session.streamTask("invalid")) events.push(event);

    expect(execute).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.completed",
        isError: true,
        error: expect.objectContaining({ code: "invalid_tool_arguments" }),
      }),
    );
    expect(provider.results[0]).toMatchObject({ token: "opaque-invalid" });
  });

  it("returns unknown-tool and handler failures without leaking stacks", async () => {
    const provider = new FakeProvider([
      {
        type: "tool.requested",
        requestToken: "unknown-token",
        actionId: "unknown-action",
        name: "missing",
        arguments: {},
      },
      {
        type: "tool.requested",
        requestToken: "failed-token",
        actionId: "failed-action",
        name: "get_nonce",
        arguments: { prefix: "x" },
      },
      { type: "task.completed" },
    ]);
    const session = new AgentSession({
      provider,
      tools: [
        nonceTool(() => {
          throw new Error("application rejected the request");
        }),
      ],
    });

    const events = [];
    for await (const event of session.streamTask("errors")) events.push(event);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.completed",
        name: "missing",
        error: expect.objectContaining({ code: "unknown_tool" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.completed",
        name: "get_nonce",
        error: {
          code: "tool_execution_failed",
          message: "application rejected the request",
        },
      }),
    );
    expect(
      provider.results.map((result) => result.output).join("\n"),
    ).not.toContain("at ");
  });

  it("maps provider failure and cancellation through the neutral API", async () => {
    const failed = new AgentSession({
      provider: new FakeProvider([
        { type: "task.failed", message: "runner failed" },
      ]),
      tools: [nonceTool()],
    });
    await expect(failed.runTask("fail")).rejects.toMatchObject({
      name: "AgentConnectError",
      code: "protocol_error",
      message: "runner failed",
    });

    const provider = new FakeProvider([{ type: "task.cancelled" }]);
    const cancelled = new AgentSession({ provider, tools: [nonceTool()] });
    await cancelled.cancel();
    expect(provider.cancelled).toBe(false);
    await expect(cancelled.runTask("cancel")).rejects.toBeInstanceOf(
      AgentConnectError,
    );
  });

  it("requires an explicit provider checkpoint and permits only one initial task", async () => {
    const session = new AgentSession({
      provider: new FakeProvider([{ type: "task.completed" }]),
      tools: [nonceTool()],
    });

    await expect(session.runTask("first")).resolves.toEqual({ text: "" });
    await expect(session.continueTask("follow up")).rejects.toMatchObject({
      code: "continuation_unavailable",
    });
    await expect(session.runTask("second initial")).rejects.toMatchObject({
      code: "protocol_error",
    });
  });

  it("does not consume the initial turn when prompt validation fails locally", async () => {
    const session = new AgentSession({
      provider: new FakeProvider([{ type: "task.completed" }]),
      tools: [nonceTool()],
    });
    await expect(session.runTask("   ")).rejects.toBeInstanceOf(TypeError);
    await expect(session.runTask("valid")).resolves.toEqual({ text: "" });
  });
});
