import { describe, expect, it, vi } from "vitest";

import {
  AgentConnectError,
  AgentSession,
  OmnigentProvider,
  defineTool,
} from "../src/index.js";

const encoder = new TextEncoder();

function sse(event: object): Uint8Array {
  const type = (event as { type: string }).type;
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
}

describe("OmnigentProvider", () => {
  it("completes a dynamic browser-tool round trip over HTTP and SSE", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const calls: Array<{
      url: string;
      init: RequestInit | undefined;
      body?: unknown;
    }> = [];
    const fetchImplementation = vi.fn(
      async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = String(input);
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ url, init, body });
        if (init?.method === "GET") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(streamController) {
                controller = streamController;
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          );
        }
        if (body?.type === "message") {
          controller?.enqueue(
            sse({
              type: "response.output_item.done",
              item: {
                id: "item-1",
                type: "function_call",
                status: "action_required",
                name: "get_nonce",
                arguments: '{"prefix":"web"}',
                call_id: "call-1",
              },
            }),
          );
        } else if (body?.type === "function_call_output") {
          controller?.enqueue(
            sse({
              type: "response.output_text.delta",
              delta: body.data.output,
            }),
          );
          controller?.enqueue(
            sse({ type: "response.completed", response: {} }),
          );
          controller?.close();
        }
        return new Response(JSON.stringify({ queued: false }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    const execute = vi.fn(
      ({ prefix }: { readonly prefix: string }) => `${prefix}-nonce`,
    );
    const session = new AgentSession({
      provider: new OmnigentProvider({
        baseUrl: "http://runtime.test/",
        sessionId: "session/with slash",
        fetch: fetchImplementation,
        headers: { Authorization: "Bearer paired" },
      }),
      tools: [
        defineTool({
          name: "get_nonce",
          description: "Return a fresh browser nonce",
          inputSchema: {
            type: "object",
            properties: { prefix: { type: "string" } },
            required: ["prefix"],
            additionalProperties: false,
          },
          execute,
        }),
      ],
    });

    await expect(session.runTask("Call the nonce tool")).resolves.toEqual({
      text: "web-nonce",
    });

    expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
      ["GET", "http://runtime.test/v1/sessions/session%2Fwith%20slash/stream"],
      ["POST", "http://runtime.test/v1/sessions/session%2Fwith%20slash/events"],
      ["POST", "http://runtime.test/v1/sessions/session%2Fwith%20slash/events"],
    ]);
    expect(calls[1]?.body).toEqual({
      type: "message",
      data: {
        role: "user",
        content: [{ type: "input_text", text: "Call the nonce tool" }],
      },
      tools: [
        {
          type: "function",
          function: {
            name: "get_nonce",
            description: "Return a fresh browser nonce",
            parameters: {
              type: "object",
              properties: { prefix: { type: "string" } },
              required: ["prefix"],
              additionalProperties: false,
            },
          },
        },
      ],
    });
    expect(calls[2]?.body).toEqual({
      type: "function_call_output",
      data: { call_id: "call-1", output: "web-nonce" },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("skips unknown events and rejects malformed recognized payloads", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sse({ type: "future.event", value: true }));
          controller.enqueue(
            sse({ type: "response.output_text.delta", delta: 42 }),
          );
          controller.close();
        },
      }),
      { status: 200 },
    );
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response("{}", { status: 202 }));
    const provider = new OmnigentProvider({
      baseUrl: "http://runtime.test",
      sessionId: "session",
      fetch: fetchImplementation,
    });

    const consume = async () => {
      for await (const _event of provider.streamTask({
        prompt: "x",
        tools: [],
      })) {
        // Consume until the malformed recognized event fails.
      }
    };
    await expect(consume()).rejects.toMatchObject({
      code: "protocol_error",
      message: expect.stringContaining("invalid delta"),
    });
  });

  it("surfaces HTTP failures and posts an explicit interrupt", async () => {
    const failedFetch = vi
      .fn()
      .mockResolvedValue(new Response("not authorized", { status: 401 }));
    const failed = new OmnigentProvider({
      baseUrl: "http://runtime.test",
      sessionId: "session",
      fetch: failedFetch,
    });
    const consume = async () => {
      for await (const _event of failed.streamTask({
        prompt: "x",
        tools: [],
      })) {
        // no-op
      }
    };
    await expect(consume()).rejects.toMatchObject({
      name: "AgentConnectError",
      code: "http_error",
      status: 401,
      message: expect.stringContaining("not authorized"),
    });

    const cancelFetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 202 }));
    const provider = new OmnigentProvider({
      baseUrl: "http://runtime.test",
      sessionId: "session",
      fetch: cancelFetch,
    });
    await provider.cancel();
    expect(JSON.parse(String(cancelFetch.mock.calls[0]?.[1]?.body))).toEqual({
      type: "interrupt",
      data: {},
    });
  });

  it("rejects malformed SSE JSON with a stable public error", async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode("event: response.completed\ndata: {bad}\n\n"),
              );
              controller.close();
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 202 }));
    const provider = new OmnigentProvider({
      baseUrl: "http://runtime.test",
      sessionId: "session",
      fetch: fetchImplementation,
    });
    const consume = async () => {
      for await (const _event of provider.streamTask({
        prompt: "x",
        tools: [],
      })) {
        // no-op
      }
    };
    await expect(consume()).rejects.toMatchObject({
      name: "AgentConnectError",
      code: "protocol_error",
    });
  });
});
