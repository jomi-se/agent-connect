import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGateway } from "../src/gateway.js";

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

  it("proxies only a valid session event route", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { baseUrl } = await start({ fetch: upstream });
    const response = await fetch(`${baseUrl}/v1/sessions/session-1/events`, {
      method: "POST",
      headers: allowedHeaders({ "Content-Type": "application/json" }),
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
