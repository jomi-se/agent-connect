import { describe, expect, it, vi } from "vitest";

import {
  OpenClawConversationUnavailableError,
  createOpenClawConversationClient,
} from "../src/openclaw-conversations.js";
import type { OpenClawConnection } from "../src/openclaw-connection.js";

const ORIGIN = "https://claw.example";
const CONVERSATION_ID = "0123456789abcdef0123456789abcdef0123";
const DESCRIPTOR = {
  conversationId: CONVERSATION_ID,
  expiresAt: 1_799_429_400_000,
  canContinue: true,
  previousResponseId: "resp_1",
};

describe("OpenClaw conversation history", () => {
  it.each([
    {
      endpoint: `${ORIGIN}/v1/responses`,
      listUrl: `${ORIGIN}/v1/agent-connect/conversations`,
    },
    {
      endpoint: `${ORIGIN}/agent-connect/v1/responses`,
      listUrl: `${ORIGIN}/agent-connect/v1/conversations`,
    },
  ])("selects the scoped path for $endpoint", async ({ endpoint, listUrl }) => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const controller = new AbortController();
    const getAccessToken = vi.fn(async () => "current-token");
    const client = createOpenClawConversationClient({
      connection: connection(endpoint),
      getAccessToken,
      fetch: vi.fn(async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json(
          String(input).endsWith("/history")
            ? {
                ...DESCRIPTOR,
                projection: "execution-history",
                entries: [
                  { kind: "input", text: "Question" },
                  { kind: "assistant", text: "Answer" },
                ],
                truncated: false,
              }
            : { conversations: [DESCRIPTOR] },
        );
      }),
    });

    const listed = await client.list({ signal: controller.signal });
    const history = await client.history(CONVERSATION_ID);
    expect(listed).toEqual([DESCRIPTOR]);
    expect(history.entries).toEqual([
      { kind: "input", text: "Question" },
      { kind: "assistant", text: "Answer" },
    ]);
    expect(Object.isFrozen(history.entries)).toBe(true);
    expect(requests.map(({ url }) => url)).toEqual([
      listUrl,
      `${listUrl}/${CONVERSATION_ID}/history`,
    ]);
    expect(requests[0]?.init).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer current-token",
    );
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it.each([
    [404, "conversation_unavailable"],
    [409, "conversation_changed"],
  ] as const)("types native %s %s", async (status, code) => {
    const client = createOpenClawConversationClient({
      connection: connection(),
      getAccessToken: async () => "token",
      fetch: async () =>
        Response.json(
          {
            error: {
              type: "invalid_request_error",
              code,
              message: "private provider detail",
            },
          },
          { status },
        ),
    });
    const error = await client.history(CONVERSATION_ID).catch((value) => value);
    expect(error).toBeInstanceOf(OpenClawConversationUnavailableError);
    expect(error).toMatchObject({ code, status });
    expect(error.message).not.toContain("private provider detail");
  });

  it("does not misclassify auth, server, or mismatched error bodies", async () => {
    for (const [status, code] of [
      [401, "conversation_unavailable"],
      [404, "conversation_changed"],
      [502, "history_unavailable"],
    ] as const) {
      const client = createOpenClawConversationClient({
        connection: connection(),
        getAccessToken: async () => "token",
        fetch: async () =>
          status === 401
            ? new Response("native unauthorized", { status })
            : Response.json(
                {
                  error: {
                    type: "invalid_request_error",
                    code,
                    message: "failure",
                  },
                },
                { status },
              ),
      });
      const error = await client.list().catch((value) => value);
      expect(error).not.toBeInstanceOf(OpenClawConversationUnavailableError);
      expect(error).toMatchObject({
        code: status === 401 ? "reauthorization_required" : "transport_error",
        status,
      });
    }
  });

  it("forwards abort to the token getter and does not fetch", async () => {
    const controller = new AbortController();
    const reason = new DOMException("stop", "AbortError");
    const fetch = vi.fn();
    const getAccessToken = vi.fn(async (signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(reason);
      throw reason;
    });
    const client = createOpenClawConversationClient({
      connection: connection(),
      getAccessToken,
      fetch,
    });

    await expect(client.list({ signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves a transport failure as the error cause without replay", async () => {
    const cause = new TypeError("network failed");
    const fetch = vi.fn(async () => {
      throw cause;
    });
    const client = createOpenClawConversationClient({
      connection: connection(),
      getAccessToken: async () => "token",
      fetch,
    });

    const error = await client.list().catch((value) => value);
    expect(error).toMatchObject({ code: "transport_error", cause });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid ids and bounded response violations", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ conversations: Array(9).fill(DESCRIPTOR) }),
    );
    const client = createOpenClawConversationClient({
      connection: connection(),
      getAccessToken: async () => "token",
      fetch,
    });
    await expect(client.history("../history")).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(fetch).not.toHaveBeenCalled();
    await expect(client.list()).rejects.toMatchObject({
      code: "invalid_response",
    });

    const oversized = createOpenClawConversationClient({
      connection: connection(),
      getAccessToken: async () => "token",
      fetch: async () =>
        Response.json({
          ...DESCRIPTOR,
          projection: "execution-history",
          entries: [{ kind: "input", text: "x".repeat(16_385) }],
          truncated: true,
        }),
    });
    await expect(oversized.history(CONVERSATION_ID)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("accepts the maximum valid projection despite JSON escaping", async () => {
    const text = "\u0001".repeat(128 * 1024);
    const client = createOpenClawConversationClient({
      connection: connection(),
      getAccessToken: async () => "token",
      fetch: async () =>
        Response.json({
          ...DESCRIPTOR,
          projection: "execution-history",
          entries: Array.from({ length: 8 }, () => ({
            kind: "assistant",
            text: text.slice(0, 16 * 1024),
          })),
          truncated: true,
        }),
    });

    await expect(client.history(CONVERSATION_ID)).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ text: text.slice(0, 16 * 1024) }),
      ]),
      truncated: true,
    });
  });
});

function connection(endpoint = `${ORIGIN}/v1/responses`): OpenClawConnection {
  return {
    version: 1,
    providerOrigin: ORIGIN,
    endpoint,
    clientId: "https://books.example",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: "2099-01-01T00:00:00.000Z",
    refreshTokenExpiresAt: "2099-02-01T00:00:00.000Z",
    model: "openclaw/default",
    applicationTools: [],
    applicationToolsHash: "h".repeat(43),
  };
}
