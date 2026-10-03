import { afterEach, expect, it, vi } from "vitest";
import {
  uiMessageChunkSchema,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { connectAgent, type AcpProvider } from "../src/acp-provider.js";
import {
  createAcpChatTransport,
  type AcpChatTransport,
} from "../src/acp-chat-transport.js";
import type { ApplicationTool } from "../src/types.js";
import { Peer } from "./acp-fixture.js";
const providers: AcpProvider[] = [];
const transports: AcpChatTransport[] = [];
const tools: ApplicationTool[] = [
  {
    name: "highlight",
    description: "Highlight",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    execute: () => ({ content: [{ type: "text", text: "highlighted" }] }),
  },
];
afterEach(async () => {
  for (const p of providers.splice(0)) p.close();
  for (const t of transports.splice(0)) await t.close();
});
async function setup(peer: Peer, applicationTools = tools) {
  const provider = await connectAgent({
    grant: { gatewayUrl: "ws://localhost/acp", token: "fixture" },
    tools: applicationTools,
    transport: { webSocket: peer.factory },
  });
  providers.push(provider);
  const transport = createAcpChatTransport({
    provider,
    tools: applicationTools,
  });
  transports.push(transport);
  return { provider, transport };
}
const user = (text: string, id = "user"): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});
function request(messages = [user("new prompt")], options = {}) {
  return {
    chatId: "ui-chat",
    trigger: "submit-message" as const,
    messageId: undefined,
    messages,
    abortSignal: undefined,
    ...options,
  };
}
async function chunks(stream: ReadableStream<UIMessageChunk>) {
  const reader = stream.getReader();
  const result: UIMessageChunk[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      expect((await uiMessageChunkSchema().validate!(next.value)).success).toBe(
        true,
      );
      result.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return result;
}
it("maps thoughts, plans, native progress, text and finish into valid UI chunks; sends only the last user text", async () => {
  const peer = new Peer();
  peer.onPrompt = (socket, _p, reply) => {
    peer.update(socket, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "think" },
    });
    peer.update(socket, {
      sessionUpdate: "plan",
      entries: [{ content: "Read", priority: "medium", status: "completed" }],
    });
    peer.update(socket, {
      sessionUpdate: "tool_call",
      toolCallId: "native",
      title: "Read file",
      status: "pending",
    });
    peer.update(socket, {
      sessionUpdate: "tool_call_update",
      toolCallId: "native",
      rawInput: { path: "/work/book" },
      status: "in_progress",
    });
    peer.update(socket, {
      sessionUpdate: "tool_call_update",
      toolCallId: "native",
      rawOutput: "book",
      status: "completed",
    });
    peer.update(socket, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "answer" },
    });
    reply({ stopReason: "end_turn" });
  };
  const { transport } = await setup(peer);
  const history: UIMessage[] = [
    {
      id: "system",
      role: "system",
      parts: [{ type: "text", text: "must not be sent" }],
    },
    user("old"),
    {
      id: "assistant",
      role: "assistant",
      parts: [{ type: "text", text: "old answer" }],
    },
    user("new prompt", "last"),
  ];
  const result = await chunks(await transport.sendMessages(request(history)));
  expect(result.map((c) => c.type)).toEqual([
    "start",
    "reasoning-start",
    "reasoning-delta",
    "data-acp-plan",
    "reasoning-end",
    "data-acp-tool",
    "data-acp-tool",
    "tool-input-available",
    "data-acp-tool",
    "tool-output-available",
    "text-start",
    "text-delta",
    "text-end",
    "finish",
  ]);
  expect(result.find((c) => c.type === "tool-input-available")).toMatchObject({
    providerExecuted: true,
    dynamic: true,
    input: { path: "/work/book" },
  });
  expect(
    peer.calls.find((c) => c.method === "session/prompt")?.params["prompt"],
  ).toEqual([{ type: "text", text: "new prompt" }]);
  await chunks(await transport.sendMessages(request([user("follow-up")])));
  expect(peer.calls.filter((c) => c.method === "session/new")).toHaveLength(1);
  const composed: UIMessage[] = [];
  const stream = new ReadableStream<UIMessageChunk>({
    start(c) {
      for (const chunk of result) c.enqueue(chunk);
      c.close();
    },
  });
  for await (const message of readUIMessageStream({ stream }))
    composed.push(message);
  expect(composed.at(-1)?.parts.some((p) => p.type === "reasoning")).toBe(true);
  expect(
    composed
      .at(-1)
      ?.parts.some(
        (p) => p.type === "dynamic-tool" && p.state === "output-available",
      ),
  ).toBe(true);
});
it("executes application tools once through AcpToolExecutor while ACP supplies their UI progress", async () => {
  const peer = new Peer();
  let executions = 0;
  peer.onPrompt = (socket, _params, reply) => {
    void (async () => {
      peer.update(socket, {
        sessionUpdate: "tool_call",
        toolCallId: "native-mcp",
        title: "Highlight",
        rawInput: { text: "hello" },
        status: "in_progress",
      });
      const connection = (await peer.request(socket, "mcp/connect", {
        serverId: "application-tools",
      })) as { connectionId: string };
      await peer.request(socket, "mcp/message", {
        connectionId: connection.connectionId,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      });
      const result = await peer.request(socket, "mcp/message", {
        connectionId: connection.connectionId,
        method: "tools/call",
        params: { name: "highlight", arguments: { text: "hello" } },
        _meta: { "agent-connect/actionId": "stable-ui-action" },
      });
      peer.update(socket, {
        sessionUpdate: "tool_call_update",
        toolCallId: "native-mcp",
        rawOutput: result,
        status: "completed",
      });
      reply({ stopReason: "end_turn" });
    })();
  };
  const { transport } = await setup(peer, [
    {
      ...tools[0]!,
      execute: (_args, context) => {
        executions++;
        expect(context.actionId).toBe("stable-ui-action");
        return "done";
      },
    },
  ]);
  const result = await chunks(await transport.sendMessages(request()));
  expect(executions).toBe(1);
  expect(result.filter((c) => c.type === "tool-input-available")).toHaveLength(
    1,
  );
  expect(result.filter((c) => c.type === "tool-output-available")).toHaveLength(
    1,
  );
});
it("rejects regeneration, foreign UI chats, non-user tails and files without sending prompts", async () => {
  const peer = new Peer();
  const { transport } = await setup(peer);
  await expect(
    transport.sendMessages({ ...request(), trigger: "regenerate-message" }),
  ).rejects.toMatchObject({ code: "protocol_error" });
  await expect(
    transport.sendMessages(
      request([
        {
          id: "assistant",
          role: "assistant",
          parts: [{ type: "text", text: "history" }],
        },
      ]),
    ),
  ).rejects.toMatchObject({ code: "protocol_error" });
  await expect(
    transport.sendMessages(
      request([
        {
          id: "u",
          role: "user",
          parts: [
            {
              type: "file",
              url: "https://example.com/file",
              mediaType: "text/plain",
            },
          ],
        },
      ]),
    ),
  ).rejects.toMatchObject({ code: "protocol_error" });
  expect(peer.calls.some((c) => c.method === "session/prompt")).toBe(false);
  await chunks(await transport.sendMessages(request()));
  await expect(
    transport.sendMessages({ ...request(), chatId: "other" }),
  ).rejects.toMatchObject({ code: "continuation_unavailable" });
});
it("emits abort for an already aborted UI request without admitting a harness prompt", async () => {
  const peer = new Peer();
  const { transport } = await setup(peer);
  const controller = new AbortController();
  controller.abort();
  const result = await chunks(
    await transport.sendMessages(
      request([user("never send")], { abortSignal: controller.signal }),
    ),
  );
  expect(result.at(-1)?.type).toBe("abort");
  expect(peer.calls.some((c) => c.method === "session/prompt")).toBe(false);
});
it("maps cancel to session/cancel and abort, with a cooperative held application handler", async () => {
  const peer = new Peer();
  let held!: () => void;
  const entered = new Promise<void>((resolve) => {
    held = resolve;
  });
  let finish!: (result: unknown) => void;
  peer.onPrompt = (socket, _p, reply) => {
    finish = reply;
    void (async () => {
      const connection = (await peer.request(socket, "mcp/connect", {
        serverId: "application-tools",
      })) as { connectionId: string };
      await peer.request(socket, "mcp/message", {
        connectionId: connection.connectionId,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      });
      void peer.request(socket, "mcp/message", {
        connectionId: connection.connectionId,
        method: "tools/call",
        params: { name: "highlight", arguments: { text: "held" } },
        _meta: { "agent-connect/actionId": "cancel-ui" },
      });
    })();
  };
  peer.onCancel = () => finish({ stopReason: "cancelled" });
  const { transport } = await setup(peer, [
    {
      ...tools[0]!,
      execute: (_args, context) =>
        new Promise<string>((resolve) => {
          held();
          context.signal!.addEventListener(
            "abort",
            () => resolve("cancelled"),
            { once: true },
          );
        }),
    },
  ]);
  const controller = new AbortController();
  const result = chunks(
    await transport.sendMessages(
      request([user("held")], { abortSignal: controller.signal }),
    ),
  );
  await entered;
  controller.abort();
  expect((await result).at(-1)?.type).toBe("abort");
  expect(peer.calls.some((c) => c.method === "session/cancel")).toBe(true);
});
it("reconnects an unlocked UI stream and keeps a healthy idle host without another prompt", async () => {
  const peer = new Peer();
  const { provider, transport } = await setup(peer);
  const stream = await transport.sendMessages(request());
  expect(await transport.reconnectToStream({ chatId: "ui-chat" })).toBe(stream);
  const reader = stream.getReader();
  await expect(
    transport.reconnectToStream({ chatId: "ui-chat" }),
  ).rejects.toMatchObject({ code: "task_busy" });
  reader.releaseLock();
  await chunks(stream);
  expect(transport.sessionId).toBe(provider.sessionId);
  expect(await transport.reconnectToStream({ chatId: "ui-chat" })).toBe(null);
  expect(peer.calls.filter((c) => c.method === "session/load")).toHaveLength(0);
  expect(peer.sockets).toHaveLength(1);
  expect(
    peer.sockets[0]!.sent.some(
      (frame) => (frame as { t?: string }).t === "bye",
    ),
  ).toBe(false);
  expect(peer.calls.filter((c) => c.method === "session/prompt")).toHaveLength(
    1,
  );
});
it("reports interrupted turns as error and permits only a deliberate new prompt after load", async () => {
  const peer = new Peer();
  peer.onPrompt = (socket) => socket.disconnect(4404);
  const { transport } = await setup(peer);
  const result = await chunks(await transport.sendMessages(request()));
  expect(result.at(-1)).toMatchObject({
    type: "error",
    errorText: expect.stringContaining("task_interrupted"),
  });
  expect(transport.error).toMatchObject({ code: "task_interrupted" });
  expect(peer.calls.filter((c) => c.method === "session/prompt")).toHaveLength(
    1,
  );
  expect(peer.calls.filter((c) => c.method === "session/load")).toHaveLength(1);
  peer.onPrompt = (_s, _p, reply) => reply({ stopReason: "end_turn" });
  expect(
    (
      await chunks(
        await transport.sendMessages(
          request([user("explicit retry as new message")]),
        ),
      )
    ).at(-1)?.type,
  ).toBe("finish");
  expect(transport.error).toBeUndefined();
});

it("refuses cold recovery of an authorization or superseded transport", async () => {
  for (const code of [4401, 4409]) {
    const peer = new Peer();
    peer.onPrompt = (socket) => socket.disconnect(code);
    const { transport } = await setup(peer);
    expect(
      (await chunks(await transport.sendMessages(request()))).at(-1)?.type,
    ).toBe("error");
    await expect(
      transport.reconnectToStream({ chatId: "ui-chat" }),
    ).rejects.toMatchObject({
      code: code === 4401 ? "invalid_app_grant" : "session_superseded",
    });
    expect(peer.calls.some((call) => call.method === "session/load")).toBe(
      false,
    );
  }
});

it("retries a rejected history load without returning or replaying an interrupted UI stream", async () => {
  const peer = new Peer();
  let attempts = 0;
  peer.onLoadSession = (_socket, _params, reply, fail) => {
    if (++attempts === 1) fail(-32603, "History temporarily unavailable");
    else reply({});
  };
  peer.onPrompt = (socket) => socket.disconnect(4404);
  const { transport } = await setup(peer);
  expect(
    (await chunks(await transport.sendMessages(request()))).at(-1),
  ).toMatchObject({
    type: "error",
    errorText: expect.stringContaining("recovery failed"),
  });
  expect(await transport.reconnectToStream({ chatId: "ui-chat" })).toBe(null);
  expect(attempts).toBe(2);
  expect(
    peer.calls.filter((call) => call.method === "session/new"),
  ).toHaveLength(1);
  expect(
    peer.calls.filter((call) => call.method === "session/prompt"),
  ).toHaveLength(1);
  peer.onPrompt = (_socket, _params, reply) =>
    reply({ stopReason: "end_turn" });
  expect(
    (
      await chunks(
        await transport.sendMessages(request([user("deliberate follow-up")])),
      )
    ).at(-1)?.type,
  ).toBe("finish");
});

it("disposal removes the UI abort listener before an unread stream is consumed", async () => {
  const peer = new Peer();
  const { transport } = await setup(peer);
  const controller = new AbortController();
  const removed = vi.spyOn(controller.signal, "removeEventListener");
  const stream = await transport.sendMessages(
    request([user("unread")], { abortSignal: controller.signal }),
  );
  await transport.close();
  expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  expect((await chunks(stream)).at(-1)?.type).toBe("abort");
  expect(peer.calls.some((call) => call.method === "session/prompt")).toBe(
    false,
  );
});

it("releases the turn before exposing finish to an immediate UI follow-up", async () => {
  const peer = new Peer();
  const { transport } = await setup(peer);
  const first = (await transport.sendMessages(request())).getReader();
  let second: ReadableStream<UIMessageChunk> | undefined;
  while (true) {
    const next = await first.read();
    if (next.done) break;
    if (next.value.type === "finish")
      second = await transport.sendMessages(
        request([user("immediate follow-up")]),
      );
  }
  expect(second).toBeDefined();
  await chunks(second!);
  expect(
    peer.calls.filter((call) => call.method === "session/new"),
  ).toHaveLength(1);
  expect(
    peer.calls.filter((call) => call.method === "session/prompt"),
  ).toHaveLength(2);
});
