import { describe, expect, it, vi } from "vitest";

import { connectAgent, defineTool } from "../src/index.js";

describe("connectAgent", () => {
  it("pairs, receives an opaque session, and runs through the neutral API", async () => {
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
      if (url.endsWith("/stream")) {
        return new Response(
          [
            sse({
              type: "response.output_item.done",
              item: {
                type: "function_call",
                status: "action_required",
                call_id: "action-1",
                name: "read_page",
                arguments: "{}",
              },
            }),
            sse({ type: "response.output_text.delta", delta: "page value" }),
            sse({ type: "response.completed" }),
          ].join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return Response.json({ accepted: true }, { status: 202 });
    });

    const connection = await connectAgent({
      baseUrl: "https://runtime.example/",
      appId: "notes-app",
      pairingCode: "AC-1234-5678-ABCD",
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
      authorization: "Pairing AC-1234-5678-ABCD",
      body: {
        appId: "notes-app",
        tools: [expect.objectContaining({ name: "read_page" })],
      },
    });
    expect(
      requests
        .filter((request) => request.url.includes("/v1/sessions/"))
        .every(
          (request) => request.authorization === "Bearer scoped-capability",
        ),
    ).toBe(true);
    expect(requests.some((request) => request.url.includes("provider"))).toBe(
      false,
    );
  });

  it("requires exactly one bootstrap credential", async () => {
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
    await expect(connectAgent(options)).rejects.toThrow(
      "pairingCode or existing accessToken",
    );
    await expect(
      connectAgent({ ...options, pairingCode: "code", accessToken: "token" }),
    ).rejects.toThrow("not both");
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
});

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
