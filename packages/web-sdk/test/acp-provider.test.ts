import { afterEach, describe, expect, it } from "vitest";
import { connectAgent, AcpProvider } from "../src/acp-provider.js";
import { AgentSession } from "../src/agent-session.js";
import { createAgentChat } from "../src/agent-chat.js";
import type {
  AgentProviderEvent,
  AgentTaskEvent,
  AgentToolDefinition,
} from "../src/types.js";
import { Peer } from "./acp-fixture.js";
const tools: AgentToolDefinition[] = [
  {
    name: "highlight",
    description: "Highlight",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];
const providers: AcpProvider[] = [];
afterEach(() => {
  for (const provider of providers.splice(0)) provider.close();
});
async function connect(peer: Peer) {
  const provider = await connectAgent({
    grant: { gatewayUrl: "ws://localhost/acp", token: "fixture" },
    tools,
    transport: { webSocket: peer.factory },
  });
  providers.push(provider);
  return provider;
}
async function collect(provider: AcpProvider, prompt = "hello") {
  const events: AgentProviderEvent[] = [];
  for await (const event of provider.streamTask({ prompt, tools }))
    events.push(event);
  return events;
}
describe("ACP provider-owned contracts", () => {
  it("creates one session, maps thought/plan/tool progress, and sends only each explicit prompt", async () => {
    const peer = new Peer();
    peer.onPrompt = (socket, _params, reply) => {
      peer.update(socket, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      });
      peer.update(socket, {
        sessionUpdate: "plan",
        entries: [{ content: "Read", priority: "high", status: "in_progress" }],
      });
      peer.update(socket, {
        sessionUpdate: "tool_call",
        toolCallId: "native",
        title: "Read",
        status: "in_progress",
        rawInput: { path: "/work/book" },
      });
      peer.update(socket, {
        sessionUpdate: "tool_call_update",
        toolCallId: "native",
        status: "completed",
        rawOutput: "book",
      });
      peer.update(socket, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "answer" },
      });
      reply({ stopReason: "end_turn" });
    };
    const provider = await connect(peer);
    const first = await collect(provider);
    await collect(provider, "next");
    expect(first.map((e) => e.type)).toEqual([
      "task.admitted",
      "thought.delta",
      "plan.updated",
      "tool.updated",
      "tool.updated",
      "text.delta",
      "task.completed",
    ]);
    expect(peer.calls.filter((c) => c.method === "session/new")).toHaveLength(
      1,
    );
    expect(
      peer.calls
        .filter((c) => c.method === "session/prompt")
        .map((c) => c.params["prompt"]),
    ).toEqual([
      [{ type: "text", text: "hello" }],
      [{ type: "text", text: "next" }],
    ]);
  });
  it("routes stable action IDs to AgentSession handlers, never into a second tool loop", async () => {
    const peer = new Peer();
    let toolResult: unknown;
    peer.onPrompt = (socket, _params, reply) => {
      void (async () => {
        const connected = (await peer.request(socket, "mcp/connect", {
          serverId: "application-tools",
        })) as { connectionId: string };
        await peer.request(socket, "mcp/message", {
          connectionId: connected.connectionId,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        });
        toolResult = await peer.request(socket, "mcp/message", {
          connectionId: connected.connectionId,
          method: "tools/call",
          params: { name: "highlight", arguments: { text: "hello" } },
          _meta: { "agent-connect/actionId": "stable-action" },
        });
        reply({ stopReason: "end_turn" });
      })();
    };
    const provider = await connect(peer);
    let executions = 0;
    const session = new AgentSession({
      provider,
      tools: [
        {
          ...tools[0]!,
          execute: (args, context) => {
            executions++;
            expect(context.actionId).toBe("stable-action");
            return { content: [{ type: "text", text: String(args["text"]) }] };
          },
        },
      ],
    });
    const events: AgentTaskEvent[] = [];
    for await (const event of session.streamTask("highlight"))
      events.push(event);
    expect(executions).toBe(1);
    expect(toolResult).toEqual({ content: [{ type: "text", text: "hello" }] });
    expect(events.some((e) => e.type === "tool.completed")).toBe(true);
    await expect(
      provider.submitToolResult("stable-action", "{}"),
    ).rejects.toMatchObject({ code: "protocol_error" });
  });
  it("rejects mutated tool snapshots and concurrent prompts; cancellation uses session/cancel", async () => {
    const peer = new Peer();
    let finish!: (result: unknown) => void;
    peer.onPrompt = (_s, _p, reply) => {
      finish = reply;
    };
    peer.onCancel = () => finish({ stopReason: "cancelled" });
    const provider = await connect(peer);
    await expect(
      provider
        .streamTask({ prompt: "bad", tools: [] })
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toMatchObject({ code: "webmcp_snapshot_invalidated" });
    const iterator = provider
      .streamTask({ prompt: "first", tools })
      [Symbol.asyncIterator]();
    await iterator.next();
    await expect(collect(provider, "second")).rejects.toMatchObject({
      code: "task_busy",
    });
    await provider.cancel();
    const remaining = [];
    for await (const e of { [Symbol.asyncIterator]: () => iterator })
      remaining.push(e);
    expect(remaining.at(-1)).toEqual({ type: "task.cancelled" });
    expect(peer.calls.some((c) => c.method === "session/cancel")).toBe(true);
  });
  it("loads after expiry, reports interruption and never re-sends the prompt or replayed text as a new turn", async () => {
    const peer = new Peer();
    peer.onPrompt = (socket) => socket.disconnect(4404);
    const provider = await connect(peer);
    const events = await collect(provider, "uncertain effect");
    expect(events.at(-1)).toMatchObject({
      type: "task.failed",
      code: "task_interrupted",
    });
    expect(events.some((e) => e.type === "text.delta")).toBe(false);
    expect(
      peer.calls.filter((c) => c.method === "session/prompt"),
    ).toHaveLength(1);
    expect(peer.calls.filter((c) => c.method === "session/load")).toHaveLength(
      1,
    );
    peer.onPrompt = (_s, _p, reply) => reply({ stopReason: "end_turn" });
    expect((await collect(provider, "explicit follow-up")).at(-1)?.type).toBe(
      "task.completed",
    );
  });
  it("does not recover authorization failure or superseded attachment", async () => {
    for (const code of [4401, 4409]) {
      const peer = new Peer();
      peer.onPrompt = (socket) => socket.disconnect(code);
      const provider = await connect(peer);
      expect((await collect(provider)).at(-1)).toMatchObject({
        type: "task.failed",
        code: code === 4401 ? "invalid_app_grant" : "session_superseded",
      });
      expect(peer.calls.some((c) => c.method === "session/load")).toBe(false);
    }
  });
  it("retains immutable ACP presentation in createAgentChat", async () => {
    const peer = new Peer();
    peer.onPrompt = (socket, _p, reply) => {
      peer.update(socket, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "why" },
      });
      peer.update(socket, {
        sessionUpdate: "plan",
        entries: [{ content: "Read", priority: "low", status: "completed" }],
      });
      reply({ stopReason: "end_turn" });
    };
    const provider = await connect(peer);
    const chat = createAgentChat({
      session: new AgentSession({
        provider,
        tools: tools.map((t) => ({ ...t, execute: () => undefined })),
      }),
    });
    await chat.send("read");
    expect(
      chat
        .getSnapshot()
        .messages.at(-1)
        ?.parts.map((p) => p.type),
    ).toEqual(["thought", "plan"]);
    await chat.dispose();
  });
  it("aborts cooperative held handlers before delivering an interrupted turn", async () => {
    const peer = new Peer();
    let executing!: () => void;
    const held = new Promise<void>((resolve) => {
      executing = resolve;
    });
    peer.onPrompt = (socket) => {
      void (async () => {
        const connected = (await peer.request(socket, "mcp/connect", {
          serverId: "application-tools",
        })) as { connectionId: string };
        await peer.request(socket, "mcp/message", {
          connectionId: connected.connectionId,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        });
        void peer.request(socket, "mcp/message", {
          connectionId: connected.connectionId,
          method: "tools/call",
          params: { name: "highlight", arguments: { text: "held" } },
          _meta: { "agent-connect/actionId": "held" },
        });
      })();
    };
    const provider = await connect(peer);
    let aborted = false;
    const session = new AgentSession({
      provider,
      tools: [
        {
          ...tools[0]!,
          execute: (_args, ctx) =>
            new Promise<string>((resolve) => {
              executing();
              ctx.signal!.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  resolve("Interrupted");
                },
                { once: true },
              );
            }),
        },
      ],
    });
    const events: AgentTaskEvent[] = [];
    const task = (async () => {
      for await (const event of session.streamTask("held")) events.push(event);
    })();
    await held;
    peer.sockets[0]!.disconnect(4404);
    await task;
    expect(aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "task.failed",
      error: { code: "task_interrupted" },
    });
    expect(
      peer.calls.filter((c) => c.method === "session/prompt"),
    ).toHaveLength(1);
  });
});
