import { asSchema, generateText, isStepCount, streamText } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  createAiSdkApplicationTools,
  createAiSdkOpenResponsesGenerationOptions,
  createAiSdkOpenResponsesModel,
  selectAiSdkOpenResponsesCheckpoint,
  type ApplicationTool,
  type JsonObject,
} from "../src/index.js";

describe("AI SDK Open Responses model", () => {
  it("resolves the bearer for every request without rebuilding the model", async () => {
    const requests: Array<{
      authorization: string | null;
      body: JsonObject;
      redirect: RequestRedirect | undefined;
    }> = [];
    let accessToken = "token-one";
    const model = createAiSdkOpenResponsesModel({
      endpoint: "https://gateway.test/v1/responses",
      model: "selected-model",
      getAccessToken: () => accessToken,
      fetch: vi.fn(async (_input, init) => {
        requests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)) as JsonObject,
          redirect: init?.redirect,
        });
        return jsonResponse(responseBody(`resp_${requests.length}`, "ok"));
      }),
    });

    await generateText({ model, prompt: "one", maxRetries: 0 });
    accessToken = "token-two";
    await generateText({ model, prompt: "two", maxRetries: 0 });

    expect(requests.map((request) => request.authorization)).toEqual([
      "Bearer token-one",
      "Bearer token-two",
    ]);
    expect(requests.map((request) => request.body.model)).toEqual([
      "selected-model",
      "selected-model",
    ]);
    expect(requests.map((request) => request.redirect)).toEqual([
      "error",
      "error",
    ]);
  });

  it("rejects unsafe endpoint forms before resolving a bearer", () => {
    const getAccessToken = vi.fn(() => "secret");
    for (const endpoint of [
      "http://gateway.test/v1/responses",
      "ftp://gateway.test/v1/responses",
      "https://user:password@gateway.test/v1/responses",
      "https://gateway.test/v1/responses#fragment",
    ]) {
      expect(() =>
        createAiSdkOpenResponsesModel({
          endpoint,
          model: "selected-model",
          getAccessToken,
        }),
      ).toThrow();
    }
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("honors cancellation while resolving a refreshed bearer", async () => {
    const controller = new AbortController();
    let release!: (token: string) => void;
    const fetch = vi.fn();
    const model = createAiSdkOpenResponsesModel({
      endpoint: "https://gateway.test/v1/responses",
      model: "selected-model",
      getAccessToken: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
      fetch,
    });
    const pending = generateText({
      model,
      prompt: "cancel",
      abortSignal: controller.signal,
      maxRetries: 0,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    controller.abort(new DOMException("stopped", "AbortError"));
    release("late-token");

    await rejection;
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves provider HTTP errors", async () => {
    const model = createAiSdkOpenResponsesModel({
      endpoint: "https://gateway.test/v1/responses",
      model: "selected-model",
      getAccessToken: () => "token",
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "grant revoked",
                type: "authorization_error",
                param: "authorization",
                code: "invalid_app_grant",
              },
            }),
            {
              status: 401,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    });

    await expect(
      generateText({ model, prompt: "denied", maxRetries: 0 }),
    ).rejects.toThrow("grant revoked");
  });

  it("does not retry an ambiguous server failure", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "admission outcome unknown",
              type: "server_error",
              param: "response",
              code: "gateway_failure",
            },
          }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const model = createAiSdkOpenResponsesModel({
      endpoint: "https://gateway.test/v1/responses",
      model: "selected-model",
      getAccessToken: () => "token",
      fetch,
    });
    const error = await generateText({
      model,
      prompt: "possibly admitted",
      ...createAiSdkOpenResponsesGenerationOptions(),
    }).catch((cause: unknown) => cause);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      message: "admission outcome unknown",
      statusCode: 500,
    });
  });

  it("documents the pinned adapter's multi-step transcript replay", async () => {
    const bodies: JsonObject[] = [];
    const model = createAiSdkOpenResponsesModel({
      endpoint: "https://gateway.test/v1/responses",
      model: "selected-model",
      getAccessToken: () => "token",
      fetch: vi.fn(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as JsonObject);
        return eventStream(
          bodies.length === 1
            ? toolCallEvents("resp_tool", "call_1", "lookup")
            : textEvents("resp_text", "done"),
        );
      }),
    });
    const tools = createAiSdkApplicationTools(
      [applicationTool("lookup", async () => "tool result")],
      { connectionId: "grant_1" },
    );

    const result = streamText({
      model,
      prompt: "use the tool",
      tools,
      stopWhen: isStepCount(2),
      maxRetries: 0,
    });
    await result.consumeStream();

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("previous_response_id");
    expect(bodies[1]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({
          type: "function_call",
          call_id: "call_1",
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_1",
          output: "tool result",
        }),
      ]),
    );
  });

  it("continues patched tool steps by response id without replay", async () => {
    const bodies: JsonObject[] = [];
    const model = createAiSdkOpenResponsesModel({
      endpoint: "https://gateway.test/v1/responses",
      model: "selected-model",
      getAccessToken: () => "token",
      fetch: vi.fn(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as JsonObject);
        return eventStream(
          bodies.length === 1
            ? toolCallEvents("resp_tool", "call_1", "lookup")
            : textEvents("resp_text", "done"),
        );
      }),
    });
    const result = streamText({
      model,
      prompt: "use the tool",
      tools: createAiSdkApplicationTools(
        [applicationTool("lookup", async () => "tool result")],
        { connectionId: "grant_1" },
      ),
      ...createAiSdkOpenResponsesGenerationOptions(),
      stopWhen: isStepCount(2),
    });
    await result.consumeStream();
    const finalStep = await result.finalStep;

    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.previous_response_id).toBe("resp_tool");
    expect(bodies[1]?.input).toEqual([
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call_1",
        output: "tool result",
      }),
    ]);
    expect(finalStep.response.id).toBe("resp_text");
    expect(selectAiSdkOpenResponsesCheckpoint(undefined, finalStep)).toBe(
      "resp_text",
    );
  });

  it("sends only a new turn after an explicit checkpoint", async () => {
    let body: JsonObject | undefined;
    const model = createAiSdkOpenResponsesModel({
      endpoint: "https://gateway.test/v1/responses",
      model: "selected-model",
      getAccessToken: () => "token",
      fetch: vi.fn(async (_input, init) => {
        body = JSON.parse(String(init?.body)) as JsonObject;
        return eventStream(textEvents("resp_next", "answer"));
      }),
    });
    const result = streamText({
      model,
      prompt: "follow up",
      ...createAiSdkOpenResponsesGenerationOptions("resp_prior"),
    });
    await result.consumeStream();

    expect(body?.previous_response_id).toBe("resp_prior");
    expect(body?.input).toEqual([expect.objectContaining({ role: "user" })]);
  });

  it("retains the last good checkpoint after a failed or refused step", () => {
    const response = { id: "resp_refused" };
    expect(
      selectAiSdkOpenResponsesCheckpoint("resp_good", {
        finishReason: "content-filter",
        response,
        text: "",
      }),
    ).toBe("resp_good");
    expect(
      selectAiSdkOpenResponsesCheckpoint("resp_good", {
        finishReason: "error",
        response: { id: "resp_failed" },
        text: "failure",
      }),
    ).toBe("resp_good");
  });
});

describe("AI SDK application tool bridge", () => {
  it("uses one fixed tool snapshot and preserves invocation context", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "complete" }],
      structuredContent: { ok: true },
    }));
    const source = applicationTool("read", execute);
    const tools = createAiSdkApplicationTools([source], {
      connectionId: "grant_1",
    });
    source.description = "mutated after snapshot";
    const read = tools.read!;
    const signal = new AbortController().signal;
    const output = await read.execute!(
      {},
      {
        toolCallId: "call_1",
        messages: [],
        abortSignal: signal,
        context: undefined,
      },
    );

    expect(read.description).toBe("Read");
    expect(Object.isFrozen(await asSchema(read.inputSchema).jsonSchema)).toBe(
      true,
    );
    expect(output).toMatchObject({ structuredContent: { ok: true } });
    expect(execute).toHaveBeenCalledWith(
      {},
      {
        signal,
        connectionId: "grant_1",
        toolName: "read",
        meta: null,
        actionId: "call_1",
      },
    );
  });

  it("validates application tool input with the CSP-safe validator", async () => {
    const execute = vi.fn();
    const tools = createAiSdkApplicationTools(
      [
        applicationTool("read", execute, {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        }),
      ],
      { connectionId: "grant_1" },
    );
    const schema = asSchema(tools.read!.inputSchema);

    expect(await schema.validate?.({ id: 4 })).toMatchObject({
      success: false,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects duplicate tool names before any execution", () => {
    expect(() =>
      createAiSdkApplicationTools(
        [applicationTool("read", vi.fn()), applicationTool("read", vi.fn())],
        { connectionId: "grant_1" },
      ),
    ).toThrow("Duplicate application tool name");
  });
});

function applicationTool(
  name: string,
  execute: ApplicationTool["execute"],
  inputSchema: ApplicationTool["inputSchema"] = { type: "object" },
): ApplicationTool & { description: string } {
  return {
    name,
    description: "Read",
    inputSchema,
    execute,
  };
}

function responseBody(id: string, text: string) {
  return {
    id,
    object: "response",
    created_at: 1,
    status: "completed",
    model: "selected-model",
    output: [
      {
        id: `message_${id}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function eventStream(events: readonly unknown[]): Response {
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

function toolCallEvents(responseId: string, callId: string, name: string) {
  const response = {
    id: responseId,
    object: "response",
    created_at: 1,
    status: "completed",
    model: "selected-model",
    output: [],
  };
  const item = {
    id: `item_${callId}`,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name,
    arguments: "{}",
  };
  return [
    { type: "response.created", sequence_number: 0, response },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item,
    },
    {
      type: "response.output_item.done",
      sequence_number: 2,
      output_index: 0,
      item,
    },
    {
      type: "response.completed",
      sequence_number: 3,
      response: { ...response, output: [item] },
    },
  ];
}

function textEvents(responseId: string, text: string) {
  const item = {
    id: `message_${responseId}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = {
    id: responseId,
    object: "response",
    created_at: 1,
    status: "completed",
    model: "selected-model",
    output: [item],
  };
  return [
    { type: "response.created", sequence_number: 0, response },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item,
    },
    {
      type: "response.output_text.delta",
      sequence_number: 2,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      sequence_number: 3,
      output_index: 0,
      item,
    },
    { type: "response.completed", sequence_number: 4, response },
  ];
}
