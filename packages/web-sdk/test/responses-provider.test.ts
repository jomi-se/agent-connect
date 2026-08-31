import { describe, expect, it, vi } from "vitest";

import {
  AgentConnectError,
  AgentSession,
  ResponsesProvider,
  defineTool,
} from "../src/index.js";
import type { AgentTaskEvent } from "../src/types.js";

const encoder = new TextEncoder();

function frame(event: object): string {
  const type = (event as { type: string }).type;
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function resource(id: string, status: string): object {
  return { id, object: "response", status, output: [] };
}

/** One complete SSE segment body, as the gateway writes it. */
function segment(id: string, ...events: object[]): Response {
  const body =
    frame({
      type: "response.created",
      sequence_number: 0,
      response: resource(id, "in_progress"),
    }) +
    events.map(frame).join("") +
    "data: [DONE]\n\n";
  return new Response(encoder.encode(body), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function textDelta(delta: string): object {
  return { type: "response.output_text.delta", sequence_number: 1, delta };
}

function functionCall(callId: string, name: string, args: string): object {
  return {
    type: "response.output_item.done",
    sequence_number: 2,
    output_index: 0,
    item: {
      type: "function_call",
      id: `fc_${callId}`,
      call_id: callId,
      name,
      arguments: args,
      status: "completed",
    },
  };
}

function completed(id: string): object {
  return {
    type: "response.completed",
    sequence_number: 9,
    response: resource(id, "completed"),
  };
}

const tool = defineTool({
  name: "get_nonce",
  description: "Return a nonce for a prefix",
  inputSchema: {
    type: "object",
    properties: { prefix: { type: "string" } },
    required: ["prefix"],
    additionalProperties: false,
  },
  execute: (arguments_) => `${String(arguments_["prefix"])}-42`,
});

function provider(responses: readonly (() => Response)[]): {
  readonly provider: ResponsesProvider;
  readonly bodies: Record<string, unknown>[];
  readonly urls: string[];
} {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  let index = 0;
  const fetchImplementation = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      if (typeof init?.body === "string") {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      const next = responses[index];
      index += 1;
      if (!next) throw new Error("unexpected extra request");
      return next();
    },
  );
  return {
    provider: new ResponsesProvider({
      baseUrl: "https://runtime.example",
      fetch: fetchImplementation as unknown as typeof globalThis.fetch,
      headers: { Authorization: "Bearer capability" },
    }),
    bodies,
    urls,
  };
}

describe("ResponsesProvider", () => {
  it("chains segments across a function call and preserves runTask", async () => {
    const harness = provider([
      () =>
        segment(
          "resp_1",
          textDelta("working"),
          functionCall("call_1", "get_nonce", '{"prefix":"web"}'),
          completed("resp_1"),
        ),
      () => segment("resp_2", textDelta("all set"), completed("resp_2")),
    ]);
    const session = new AgentSession({
      provider: harness.provider,
      tools: [tool],
    });

    const events: AgentTaskEvent[] = [];
    for await (const event of session.streamTask("do the thing")) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "task.started",
      "text.delta",
      "tool.requested",
      "tool.completed",
      "text.delta",
      "task.completed",
    ]);
    expect(events.at(-1)).toEqual({
      type: "task.completed",
      text: "workingall set",
    });

    // The first request is an ordinary initial response; the second continues
    // the same chain with exactly one function_call_output.
    expect(harness.urls).toEqual([
      "https://runtime.example/v1/responses",
      "https://runtime.example/v1/responses",
    ]);
    expect(harness.bodies[0]).toMatchObject({
      model: "agent-connect/default",
      stream: true,
      input: "do the thing",
      tools: [
        {
          type: "function",
          name: "get_nonce",
          description: "Return a nonce for a prefix",
        },
      ],
    });
    expect(harness.bodies[1]).toMatchObject({
      model: "agent-connect/default",
      previous_response_id: "resp_1",
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: expect.stringContaining("web-42"),
        },
      ],
    });
    expect(harness.bodies[1]).not.toHaveProperty("tools");
  });

  it("completes a text-only task in one segment", async () => {
    const harness = provider([
      () => segment("resp_1", textDelta("hello"), completed("resp_1")),
    ]);
    const session = new AgentSession({
      provider: harness.provider,
      tools: [tool],
    });
    const result = await session.runTask("say hello");
    expect(result).toEqual({ text: "hello" });
  });

  it("continues a completed task from its opaque response checkpoint", async () => {
    const harness = provider([
      () => segment("resp_1", textDelta("draft"), completed("resp_1")),
      () => segment("resp_2", textDelta("revised"), completed("resp_2")),
    ]);
    const session = new AgentSession({
      provider: harness.provider,
      tools: [tool],
    });

    await expect(session.runTask("write it")).resolves.toEqual({
      text: "draft",
    });
    await expect(session.continueTask("make it shorter")).resolves.toEqual({
      text: "revised",
    });
    expect(harness.bodies[1]).toEqual({
      model: "agent-connect/default",
      stream: true,
      input: "make it shorter",
      previous_response_id: "resp_1",
    });
  });

  it("invalidates the previous checkpoint when a continued turn fails", async () => {
    const harness = provider([
      () => segment("resp_1", completed("resp_1")),
      () =>
        segment("resp_2", {
          type: "response.failed",
          sequence_number: 3,
          response: {
            ...resource("resp_2", "failed"),
            error: { code: "backend_unavailable", message: "runtime is gone" },
          },
        }),
    ]);
    const session = new AgentSession({
      provider: harness.provider,
      tools: [tool],
    });
    await session.runTask("first");
    await expect(session.continueTask("second")).rejects.toThrow(
      "runtime is gone",
    );
    await expect(session.continueTask("third")).rejects.toMatchObject({
      code: "continuation_unavailable",
    });
  });

  it("does not publish an empty checkpoint when response.created is missing", async () => {
    const raw = new Response(
      encoder.encode(frame(completed("resp_missing")) + "data: [DONE]\n\n"),
      { headers: { "Content-Type": "text/event-stream" } },
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async () => raw);
    const session = new AgentSession({
      provider: new ResponsesProvider({
        baseUrl: "https://runtime.example",
        fetch,
      }),
      tools: [tool],
    });
    await expect(session.runTask("hello")).rejects.toMatchObject({
      code: "protocol_error",
    });
  });

  it("reports a failed response as a task failure", async () => {
    const harness = provider([
      () =>
        segment("resp_1", {
          type: "response.failed",
          sequence_number: 3,
          response: {
            ...resource("resp_1", "failed"),
            error: { code: "backend_unavailable", message: "runtime is gone" },
          },
        }),
    ]);
    const session = new AgentSession({
      provider: harness.provider,
      tools: [tool],
    });
    const events: AgentTaskEvent[] = [];
    for await (const event of session.streamTask("hi")) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: "task.failed",
      error: { message: "runtime is gone" },
    });
  });

  it("surfaces a rejected request with the gateway's error code", async () => {
    const harness = provider([
      () =>
        new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              code: "unsupported_feature",
              message: "temperature is outside the profile",
              param: "temperature",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    ]);
    const session = new AgentSession({
      provider: harness.provider,
      tools: [tool],
    });
    await expect(session.runTask("hi")).rejects.toThrow(/unsupported_feature/);
  });

  it("maps gateway contention and stale continuation to neutral recovery codes", async () => {
    const busyHarness = provider([
      () =>
        Response.json(
          { error: { code: "response_busy", message: "already running" } },
          { status: 409 },
        ),
    ]);
    const busy = new AgentSession({
      provider: busyHarness.provider,
      tools: [tool],
    });
    await expect(busy.runTask("hi")).rejects.toMatchObject({
      code: "task_busy",
    });

    const staleHarness = provider([
      () => segment("resp_1", completed("resp_1")),
      () =>
        Response.json(
          {
            error: {
              code: "previous_response_not_continuable",
              message: "stale head",
            },
          },
          { status: 409 },
        ),
    ]);
    const stale = new AgentSession({
      provider: staleHarness.provider,
      tools: [tool],
    });
    await stale.runTask("first");
    await expect(stale.continueTask("again")).rejects.toMatchObject({
      code: "continuation_unavailable",
    });
  });

  it("returns a tool error to the agent without ending the chain", async () => {
    const harness = provider([
      () =>
        segment(
          "resp_1",
          functionCall("call_1", "get_nonce", '{"wrong":"shape"}'),
          completed("resp_1"),
        ),
      () => segment("resp_2", textDelta("recovered"), completed("resp_2")),
    ]);
    const session = new AgentSession({
      provider: harness.provider,
      tools: [tool],
    });
    const events: AgentTaskEvent[] = [];
    for await (const event of session.streamTask("hi")) events.push(event);

    const completedTool = events.find(
      (event) => event.type === "tool.completed",
    );
    expect(completedTool).toMatchObject({
      isError: true,
      error: { code: "invalid_tool_arguments" },
    });
    expect(events.at(-1)).toMatchObject({ type: "task.completed" });
    // The invalid-argument report still travels as an ordinary function output.
    expect(harness.bodies[1]).toMatchObject({
      previous_response_id: "resp_1",
    });
  });

  it("cancels a chain parked on an unanswered call", async () => {
    const harness = provider([
      () =>
        segment(
          "resp_1",
          functionCall("call_1", "get_nonce", '{"prefix":"web"}'),
          completed("resp_1"),
        ),
      () => new Response(null, { status: 200 }),
    ]);
    const task = harness.provider.streamTask({
      prompt: "hi",
      tools: [
        {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
      ],
    });
    const stream = task[Symbol.asyncIterator]();

    const requested = await stream.next();
    expect(requested.value).toMatchObject({ type: "tool.requested" });
    await harness.provider.cancel();
    expect(await stream.next()).toEqual({
      value: { type: "task.cancelled" },
      done: false,
    });
    expect(harness.urls.at(-1)).toBe(
      "https://runtime.example/v1/agent-connect/responses/resp_1/cancel",
    );
  });

  it("refuses a second concurrent task on one provider", async () => {
    const harness = provider([
      () => segment("resp_1", textDelta("hi"), completed("resp_1")),
    ]);
    const first = harness.provider.streamTask({ prompt: "a", tools: [] });
    await first[Symbol.asyncIterator]().next();
    const second = harness.provider.streamTask({ prompt: "b", tools: [] });
    await expect(second[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(
      AgentConnectError,
    );
  });
});
