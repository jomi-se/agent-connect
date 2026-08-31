import { describe, expect, it, vi } from "vitest";

import { connectAgent, defineTool } from "../src/index.js";

describe("connectAgent", () => {
  it("requests a fresh application session without requiring a new grant", async () => {
    let body: unknown;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init = {}) => {
      body = init.body ? JSON.parse(String(init.body)) : undefined;
      return Response.json(
        {
          sessionId: "acs_fresh",
          accessToken: "fresh-capability",
          expiresAt: "2099-01-01T00:00:00.000Z",
          toolHash: "snapshot-hash",
        },
        { status: 201 },
      );
    });
    await connectAgent({
      baseUrl: "https://runtime.example",
      appId: "notes-app",
      accessToken: "existing-application-grant",
      freshSession: true,
      fetch,
      tools: [
        defineTool({
          name: "read_page",
          description: "Read the current page",
          inputSchema: { type: "object", additionalProperties: false },
          execute: () => "page",
        }),
      ],
    });
    expect(body).toMatchObject({ appId: "notes-app", fresh: true });
  });

  it("uses an app grant, receives an opaque session, and runs through the neutral API", async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      const headers = new Headers(init.headers);
      requests.push({
        url,
        method,
        authorization: headers.get("authorization"),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/v1/app-sessions")) {
        return Response.json(
          {
            sessionId: "acs_public",
            accessToken: "scoped-capability",
            expiresAt: "2099-01-01T00:00:00.000Z",
            toolHash: "snapshot-hash",
          },
          { status: 201 },
        );
      }
      if (url.endsWith("/v1/responses")) {
        const continuation = requests.filter((request) =>
          request.url.endsWith("/v1/responses"),
        ).length;
        const responseId = `resp_${continuation}`;
        const events =
          continuation === 1
            ? [
                created(responseId),
                {
                  type: "response.output_item.done",
                  item: {
                    type: "function_call",
                    status: "completed",
                    call_id: "action-1",
                    name: "read_page",
                    arguments: "{}",
                  },
                },
                completed(responseId),
              ]
            : [
                created(responseId),
                { type: "response.output_text.delta", delta: "page value" },
                completed(responseId),
              ];
        return new Response(events.map(sse).join("") + "data: [DONE]\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return Response.json({ error: "unexpected_request" }, { status: 500 });
    });

    const connection = await connectAgent({
      baseUrl: "https://runtime.example/",
      appId: "notes-app",
      accessToken: "application-grant",
      fetch,
      tools: [
        defineTool({
          name: "read_page",
          description: "Read the current page",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          execute: () => "page value",
        }),
      ],
    });
    expect(connection.sessionId).toBe("acs_public");
    expect(await connection.session.runTask("Read it")).toEqual({
      text: "page value",
    });
    expect(requests[0]).toMatchObject({
      url: "https://runtime.example/v1/app-sessions",
      method: "POST",
      authorization: "Bearer application-grant",
      body: {
        appId: "notes-app",
        tools: [expect.objectContaining({ name: "read_page" })],
      },
    });
    const responseRequests = requests.filter((request) =>
      request.url.endsWith("/v1/responses"),
    );
    expect(responseRequests).toHaveLength(2);
    expect(
      responseRequests.every(
        (request) => request.authorization === "Bearer scoped-capability",
      ),
    ).toBe(true);
    expect(responseRequests[0]?.body).toMatchObject({
      model: "agent-connect/default",
      input: "Read it",
      tools: [expect.objectContaining({ name: "read_page" })],
    });
    expect(responseRequests[1]?.body).toMatchObject({
      model: "agent-connect/default",
      previous_response_id: "resp_1",
      input: [
        expect.objectContaining({
          type: "function_call_output",
          call_id: "action-1",
        }),
      ],
    });
    expect(
      requests.some((request) => request.url.includes("/v1/sessions/")),
    ).toBe(false);
    expect(requests.some((request) => request.url.includes("provider"))).toBe(
      false,
    );
  });

  it("requires a non-empty application grant", async () => {
    const options = {
      baseUrl: "https://runtime.example",
      appId: "app",
      tools: [
        defineTool({
          name: "read",
          description: "Read",
          inputSchema: { type: "object" },
          execute: () => "ok",
        }),
      ],
    };
    await expect(connectAgent({ ...options, accessToken: "" })).rejects.toThrow(
      "application grant accessToken",
    );
  });

  it("surfaces a revoked application grant as a typed recovery error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: "invalid_app_grant" }, { status: 401 }),
    );

    await expect(
      connectAgent({
        baseUrl: "https://runtime.example",
        appId: "notes-app",
        accessToken: "revoked-grant",
        fetch,
        tools: [
          defineTool({
            name: "read",
            description: "Read",
            inputSchema: { type: "object" },
            execute: () => "ok",
          }),
        ],
      }),
    ).rejects.toMatchObject({
      name: "AgentConnectError",
      code: "invalid_app_grant",
      status: 401,
    });
  });

  it("surfaces a capacity refusal with the page that resolves it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          error: "session_capacity",
          message: "at most 8 live sessions",
          manageUrl: "https://runtime.example/sessions",
        },
        { status: 429, headers: { "Retry-After": "30" } },
      ),
    );
    const failure = await connectAgent({
      baseUrl: "https://runtime.example",
      appId: "demo",
      accessToken: "grant-token",
      fetch,
      tools: [probeTool()],
    }).catch((error: unknown) => error);

    // Retrying into a full gateway is not a remedy; ending a session is, so the
    // application needs the code and somewhere to send the person.
    expect(failure).toMatchObject({
      name: "AgentConnectError",
      code: "session_capacity",
      status: 429,
      manageUrl: "https://runtime.example/sessions",
    });
  });

  it("distinguishes a retired session from an invalid capability", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: "session_expired" }, { status: 401 }),
    );
    const failure = await connectAgent({
      baseUrl: "https://runtime.example",
      appId: "demo",
      accessToken: "grant-token",
      fetch,
      tools: [probeTool()],
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "session_expired", status: 401 });
  });
});

function probeTool() {
  return defineTool({
    name: "read_page",
    description: "Read the current page",
    inputSchema: { type: "object", additionalProperties: false },
    execute: () => "page",
  });
}

function sse(event: unknown): string {
  const type = (event as { type: string }).type;
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function created(id: string): object {
  return {
    type: "response.created",
    response: { id, object: "response", status: "in_progress", output: [] },
  };
}

function completed(id: string): object {
  return {
    type: "response.completed",
    response: { id, object: "response", status: "completed", output: [] },
  };
}
