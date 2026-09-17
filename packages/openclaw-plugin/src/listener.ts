import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import type { AgentConnectEndpointLayout } from "./authorization/contracts.js";
import type { AgentConnectAdmissionController } from "./runtime/admission.js";

const LISTEN_HOST = "127.0.0.1";

export interface AgentConnectListener {
  readonly host: typeof LISTEN_HOST;
  readonly port: number;
  close(): Promise<void>;
}

export async function startAgentConnectListener(options: {
  readonly port: number;
  readonly endpoints: AgentConnectEndpointLayout;
  readonly dispatch: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>;
  readonly admission?: AgentConnectAdmissionController;
  readonly onError?: (error: Error) => void;
}): Promise<AgentConnectListener> {
  let accepting = true;
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    applyPublicResponsePolicy(response);
    const admission = options.admission?.tryEnterHttp();
    if (options.admission && !admission) {
      response.setHeader("retry-after", "1");
      sendJsonError(response, 503, "service_busy");
      return;
    }
    const releaseAdmission = () => admission?.release();
    response.once("finish", releaseAdmission);
    response.once("close", releaseAdmission);
    if (!accepting) {
      sendJsonError(response, 503, "service_stopping");
      return;
    }
    if (!isAgentConnectRoute(request.url, options.endpoints)) {
      sendJsonError(response, 404, "not_found");
      return;
    }
    void options.dispatch(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJsonError(response, 500, "internal_error");
    });
  });
  configureServer(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown) => {
        server.off("listening", onListening);
        reject(listenerBindError(options.port, error));
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(options.port, LISTEN_HOST);
    });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    throw error;
  }
  server.on("error", (error) =>
    options.onError?.(listenerBindError(options.port, error)),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Agent Connect listener did not expose a TCP address");
  }

  return {
    host: LISTEN_HOST,
    port: address.port,
    async close() {
      if (!accepting) return;
      accepting = false;
      if (!server.listening) return;
      server.closeIdleConnections();
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      closed.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const graceful = await Promise.race([
        closed.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 500);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!graceful) {
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await closed;
      }
    },
  };
}

function applyPublicResponsePolicy(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-robots-tag", "noindex, nofollow, noarchive, nosnippet");
}

function configureServer(server: Server): void {
  server.headersTimeout = 15_000;
  // This limits receipt of request headers and bodies only; it does not cap a
  // long-lived SSE response. Silent streamed responses therefore remain valid
  // while slow request-body attacks release their shared admission slot.
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
}

function isAgentConnectRoute(
  requestTarget: string | undefined,
  endpoints: AgentConnectEndpointLayout,
): boolean {
  if (
    !requestTarget ||
    !requestTarget.startsWith("/") ||
    requestTarget.startsWith("//")
  ) {
    return false;
  }
  let pathname: string;
  try {
    pathname = new URL(requestTarget, "http://127.0.0.1").pathname;
  } catch {
    return false;
  }
  return (
    pathname === endpoints.authorizationServerMetadataPath ||
    pathname === endpoints.protectedResourceMetadataPath ||
    pathname === endpoints.issuerPath ||
    pathname.startsWith(`${endpoints.issuerPath}/`)
  );
}

function listenerBindError(port: number, error: unknown): Error {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
  if (code === "EADDRINUSE") {
    return new Error(
      `Agent Connect listen port ${port} is already in use on ${LISTEN_HOST}`,
    );
  }
  if (code === "EACCES") {
    return new Error(
      `Agent Connect lacks permission to listen on ${LISTEN_HOST}:${port}`,
    );
  }
  return new Error(
    `Agent Connect could not listen on ${LISTEN_HOST}:${port}${code ? ` (${code})` : ""}`,
  );
}

function sendJsonError(
  response: ServerResponse,
  status: number,
  code: string,
): void {
  const body = Buffer.from(
    JSON.stringify({
      error: { type: "server_error", code, message: "Route unavailable" },
    }),
  );
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
  });
  response.end(body);
}
