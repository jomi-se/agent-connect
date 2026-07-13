import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGateway } from "../src/gateway.js";
import type { AgentRuntime } from "../src/runtime.js";

const servers: ReturnType<typeof createGateway>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

describe("gateway", () => {
  it("answers an allowed CORS preflight without requiring identity", async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/v1/sessions/session-1/events`, {
      method: "OPTIONS",
      headers: { Origin: "https://preview.example" },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://preview.example",
    );
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("rejects an unlisted origin before proxying", async () => {
    const upstream = vi.fn<typeof fetch>();
    const { baseUrl } = await start({ fetch: upstream });
    const response = await fetch(`${baseUrl}/v1/sessions/session-1/stream`, {
      headers: {
        Origin: "https://evil.example",
        "Tailscale-User-Login": "owner@example.com",
      },
    });

    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a missing or unlisted Tailscale identity", async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/v1/sessions/session-1/stream`, {
      headers: { Origin: "https://preview.example" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "tailscale_user_not_allowed",
    });
  });

  it("requires the configured bearer token", async () => {
    const { baseUrl } = await start({ accessToken: "correct horse" });
    const response = await fetch(`${baseUrl}/v1/sessions/session-1/stream`, {
      headers: allowedHeaders({ Authorization: "Bearer wrong" }),
    });

    expect(response.status).toBe(401);
  });

  it("does not expose raw provider sessions unless legacy mode is enabled", async () => {
    const upstream = vi.fn<typeof fetch>();
    const { baseUrl } = await start({ fetch: upstream });
    const response = await fetch(`${baseUrl}/v1/sessions/conv_secret/stream`, {
      headers: allowedHeaders(),
    });

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("proxies only a valid session event route", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { baseUrl } = await start({
      fetch: upstream,
      accessToken: "legacy-token",
    });
    const response = await fetch(`${baseUrl}/v1/sessions/session-1/events`, {
      method: "POST",
      headers: allowedHeaders({
        Authorization: "Bearer legacy-token",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ type: "interrupt", data: {} }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(upstream).toHaveBeenCalledWith(
      "http://127.0.0.1:6767/v1/sessions/session-1/events",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("managed application sessions", () => {
  it("exchanges a single-use code and hides the provider session id", async () => {
    const runtime = new FakeRuntime();
    const codes: string[] = [];
    const { baseUrl } = await start({
      runtime,
      pairingCode: "PAIR-ONCE",
      capabilitySigningSecret: "test-signing-secret",
      onPairingCodeGenerated: (code) => codes.push(code),
    });

    const response = await createAppSession(baseUrl, "Pairing PAIR-ONCE");
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({
      sessionId: expect.stringMatching(/^acs_/),
      accessToken: expect.any(String),
      toolHash: expect.any(String),
    });
    expect(JSON.stringify(created)).not.toContain("provider-1");
    expect(runtime.created).toHaveLength(1);
    expect(codes).toHaveLength(2);

    const replay = await createAppSession(baseUrl, "Pairing PAIR-ONCE");
    expect(replay.status).toBe(401);
    expect(runtime.created).toHaveLength(1);
  });

  it("binds a capability to origin, session, and exact tool envelope", async () => {
    const runtime = new FakeRuntime();
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('data: {"type":"response.completed"}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const { baseUrl } = await start({
      runtime,
      fetch: upstream,
      pairingCode: "PAIR-BOUND",
      capabilitySigningSecret: "test-signing-secret",
      allowedOrigins: new Set([
        "https://preview.example",
        "https://other.example",
      ]),
    });
    const paired = await createAppSession(baseUrl, "Pairing PAIR-BOUND");
    const created = await paired.json();
    const sessionUrl = `${baseUrl}/v1/sessions/${created.sessionId as string}`;

    const stream = await fetch(`${sessionUrl}/stream`, {
      headers: allowedHeaders({
        Authorization: `Bearer ${created.accessToken as string}`,
      }),
    });
    expect(stream.status).toBe(200);
    expect(upstream).toHaveBeenCalledWith(
      "http://127.0.0.1:6767/v1/sessions/provider-1/stream",
      expect.anything(),
    );

    const wrongOrigin = await fetch(`${sessionUrl}/stream`, {
      headers: {
        ...allowedHeaders({
          Authorization: `Bearer ${created.accessToken as string}`,
        }),
        Origin: "https://other.example",
      },
    });
    expect(wrongOrigin.status).toBe(401);

    const tampered = await fetch(`${sessionUrl}/stream`, {
      headers: allowedHeaders({
        Authorization: `Bearer ${created.accessToken as string}x`,
      }),
    });
    expect(tampered.status).toBe(401);

    upstream.mockClear();
    const mismatch = await fetch(`${sessionUrl}/events`, {
      method: "POST",
      headers: allowedHeaders({
        Authorization: `Bearer ${created.accessToken as string}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(messageEvent([{ ...tool(), name: "other_tool" }])),
    });
    expect(mismatch.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("reuses a healthy match and heals it when the provider goes offline", async () => {
    const runtime = new FakeRuntime();
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const { baseUrl } = await start({
      runtime,
      fetch: upstream,
      pairingCode: "PAIR-HEAL",
      capabilitySigningSecret: "test-signing-secret",
    });
    const first = await createAppSession(baseUrl, "Pairing PAIR-HEAL");
    const created = await first.json();

    const reused = await createAppSession(
      baseUrl,
      `Bearer ${created.accessToken as string}`,
    );
    expect(reused.status).toBe(201);
    expect((await reused.json()).sessionId).toBe(created.sessionId);
    expect(runtime.created).toHaveLength(1);

    runtime.healthy = false;
    const [stream, concurrentStream] = await Promise.all([
      fetch(`${baseUrl}/v1/sessions/${created.sessionId as string}/stream`, {
        headers: allowedHeaders({
          Authorization: `Bearer ${created.accessToken as string}`,
        }),
      }),
      fetch(`${baseUrl}/v1/sessions/${created.sessionId as string}/stream`, {
        headers: allowedHeaders({
          Authorization: `Bearer ${created.accessToken as string}`,
        }),
      }),
    ]);
    expect(stream.status).toBe(200);
    expect(concurrentStream.status).toBe(200);
    expect(runtime.created).toHaveLength(2);
    expect(upstream).toHaveBeenCalledWith(
      "http://127.0.0.1:6767/v1/sessions/provider-2/stream",
      expect.anything(),
    );
  });

  it("rejects expired capabilities and changed snapshots", async () => {
    let clock = Date.parse("2026-07-13T20:00:00Z");
    const runtime = new FakeRuntime();
    const { baseUrl } = await start({
      runtime,
      pairingCode: "PAIR-TIME",
      capabilitySigningSecret: "test-signing-secret",
      capabilityTtlSeconds: 10,
      now: () => clock,
    });
    const paired = await createAppSession(baseUrl, "Pairing PAIR-TIME");
    const created = await paired.json();

    const changed = await createAppSession(
      baseUrl,
      `Bearer ${created.accessToken as string}`,
      [{ ...tool(), description: "A changed capability" }],
    );
    expect(changed.status).toBe(401);

    clock += 11_000;
    const expired = await fetch(
      `${baseUrl}/v1/sessions/${created.sessionId as string}/stream`,
      {
        headers: allowedHeaders({
          Authorization: `Bearer ${created.accessToken as string}`,
        }),
      },
    );
    expect(expired.status).toBe(401);
  });
});

async function start(
  overrides: Partial<Parameters<typeof createGateway>[0]> = {},
) {
  const server = createGateway({
    allowedOrigins: new Set(["https://preview.example"]),
    allowedTailscaleUsers: new Set(["owner@example.com"]),
    omnigentBaseUrl: "http://127.0.0.1:6767",
    ...overrides,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

function allowedHeaders(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    Origin: "https://preview.example",
    "Tailscale-User-Login": "owner@example.com",
    ...extra,
  };
}

function tool() {
  return {
    name: "set_page_message",
    description: "Set one visible page message",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
  };
}

function messageEvent(tools: readonly ReturnType<typeof tool>[]) {
  return {
    type: "message",
    data: {
      role: "user",
      content: [{ type: "input_text", text: "Update the page" }],
    },
    tools: tools.map((item) => ({
      type: "function",
      function: {
        name: item.name,
        description: item.description,
        parameters: item.inputSchema,
      },
    })),
  };
}

async function createAppSession(
  baseUrl: string,
  authorization: string,
  tools: readonly ReturnType<typeof tool>[] = [tool()],
) {
  return fetch(`${baseUrl}/v1/app-sessions`, {
    method: "POST",
    headers: allowedHeaders({
      Authorization: authorization,
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ appId: "test-app", tools }),
  });
}

class FakeRuntime implements AgentRuntime {
  readonly created: Array<{
    appId: string;
    origin: string;
    toolHash: string;
  }> = [];
  healthy = true;

  async createSession(request: {
    appId: string;
    origin: string;
    toolHash: string;
  }): Promise<string> {
    this.created.push(request);
    this.healthy = true;
    return `provider-${this.created.length}`;
  }

  async isHealthy(): Promise<boolean> {
    return this.healthy;
  }
}
