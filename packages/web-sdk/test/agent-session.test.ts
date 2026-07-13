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

describe("AgentSession", () => {
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
    expect(provider.cancelled).toBe(true);
    await expect(cancelled.runTask("cancel")).rejects.toBeInstanceOf(
      AgentConnectError,
    );
  });
});
