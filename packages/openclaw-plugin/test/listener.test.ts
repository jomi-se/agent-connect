import { connect } from "node:net";
import { describe, expect, it, vi } from "vitest";

import { STOCK_PLUGIN_ENDPOINT_LAYOUT } from "../../gateway/src/openclaw-plugin/contracts.js";
import { startAgentConnectListener } from "../src/listener.js";

describe("dedicated Agent Connect listener", () => {
  it("dispatches only the metadata and Agent Connect route boundary", async () => {
    const dispatch = vi.fn(async (_request, response) => {
      response.writeHead(204).end();
    });
    const listener = await startAgentConnectListener({
      port: 0,
      endpoints: STOCK_PLUGIN_ENDPOINT_LAYOUT,
      dispatch,
    });
    const baseUrl = `http://${listener.host}:${listener.port}`;
    try {
      for (const path of [
        STOCK_PLUGIN_ENDPOINT_LAYOUT.authorizationServerMetadataPath,
        STOCK_PLUGIN_ENDPOINT_LAYOUT.protectedResourceMetadataPath,
        "/agent-connect/healthz",
      ]) {
        expect((await fetch(`${baseUrl}${path}`)).status).toBe(204);
      }
      for (const path of [
        "/",
        "/terminal",
        "/v1/responses",
        "/agent-connectivity",
        "/agent-connect%2Fhealthz",
        "/.well-known/oauth-authorization-server/unknown",
      ]) {
        expect((await fetch(`${baseUrl}${path}`)).status).toBe(404);
      }
      expect(dispatch).toHaveBeenCalledTimes(3);
    } finally {
      await listener.close();
    }
  });

  it("sanitizes async dispatcher failures", async () => {
    const listener = await startAgentConnectListener({
      port: 0,
      endpoints: STOCK_PLUGIN_ENDPOINT_LAYOUT,
      dispatch: async () => {
        throw new Error("secret internal failure");
      },
    });
    try {
      const response = await fetch(
        `http://${listener.host}:${listener.port}/agent-connect/healthz`,
      );
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("secret internal failure");
    } finally {
      await listener.close();
    }
  });

  it("does not fall back when occupied and releases the same port on close", async () => {
    const first = await startAgentConnectListener({
      port: 0,
      endpoints: STOCK_PLUGIN_ENDPOINT_LAYOUT,
      dispatch: async (_request, response) => {
        response.writeHead(204).end();
      },
    });
    await expect(
      startAgentConnectListener({
        port: first.port,
        endpoints: STOCK_PLUGIN_ENDPOINT_LAYOUT,
        dispatch: async (_request, response) => {
          response.writeHead(204).end();
        },
      }),
    ).rejects.toThrow(`listen port ${first.port} is already in use`);
    expect(
      (await fetch(`http://${first.host}:${first.port}/agent-connect/healthz`))
        .status,
    ).toBe(204);

    const port = first.port;
    await first.close();
    const replacement = await startAgentConnectListener({
      port,
      endpoints: STOCK_PLUGIN_ENDPOINT_LAYOUT,
      dispatch: async (_request, response) => {
        response.writeHead(204).end();
      },
    });
    await replacement.close();
  });

  it("closes unsupported upgrade and CONNECT sockets", async () => {
    const listener = await startAgentConnectListener({
      port: 0,
      endpoints: STOCK_PLUGIN_ENDPOINT_LAYOUT,
      dispatch: async (_request, response) => {
        response.writeHead(204).end();
      },
    });
    try {
      await expectSocketClosed(
        listener.port,
        "GET /agent-connect/healthz HTTP/1.1\r\nHost: localhost\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      await expectSocketClosed(
        listener.port,
        "CONNECT example.test:443 HTTP/1.1\r\nHost: example.test\r\n\r\n",
      );
    } finally {
      await listener.close();
    }
  });
});

async function expectSocketClosed(
  port: number,
  request: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("listener left unsupported socket open"));
    }, 2_000);
    socket.once("connect", () => socket.write(request));
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
