import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export interface GatewayOptions {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowedTailscaleUsers: ReadonlySet<string>;
  readonly omnigentBaseUrl: string;
  readonly accessToken?: string;
  readonly fetch?: typeof globalThis.fetch;
}

const SESSION_ROUTE = /^\/v1\/sessions\/([^/]+)\/(stream|events)$/;
const MAX_EVENT_BYTES = 1024 * 1024;

export function createGateway(options: GatewayOptions) {
  if (options.allowedOrigins.size === 0) {
    throw new TypeError("At least one allowed browser origin is required");
  }
  if (options.allowedTailscaleUsers.size === 0) {
    throw new TypeError("At least one allowed Tailscale login is required");
  }
  const fetchImplementation =
    options.fetch ?? globalThis.fetch.bind(globalThis);
  const omnigentBaseUrl = options.omnigentBaseUrl.replace(/\/$/, "");

  return createServer(async (request, response) => {
    try {
      if (request.url === "/healthz" && request.method === "GET") {
        sendJson(response, 200, { ok: true });
        return;
      }

      const origin = header(request, "origin");
      if (!origin || !options.allowedOrigins.has(origin)) {
        sendJson(response, 403, { error: "origin_not_allowed" });
        return;
      }
      setCors(response, origin);

      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      const tailscaleUser = header(request, "tailscale-user-login");
      if (!tailscaleUser || !options.allowedTailscaleUsers.has(tailscaleUser)) {
        sendJson(response, 403, { error: "tailscale_user_not_allowed" });
        return;
      }
      if (
        options.accessToken &&
        !hasBearerToken(request, options.accessToken)
      ) {
        response.setHeader("WWW-Authenticate", "Bearer");
        sendJson(response, 401, { error: "invalid_access_token" });
        return;
      }

      const pathname = new URL(request.url ?? "/", "http://gateway.invalid")
        .pathname;
      const match = SESSION_ROUTE.exec(pathname);
      if (!match) {
        sendJson(response, 404, { error: "route_not_found" });
        return;
      }
      const sessionId = decodeURIComponent(match[1] ?? "");
      const operation = match[2];
      if (!isSafeSessionId(sessionId)) {
        sendJson(response, 400, { error: "invalid_session_id" });
        return;
      }
      if (
        (operation === "stream" && request.method !== "GET") ||
        (operation === "events" && request.method !== "POST")
      ) {
        response.setHeader("Allow", operation === "stream" ? "GET" : "POST");
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }

      const body =
        request.method === "POST" ? await readBody(request) : undefined;
      const controller = new AbortController();
      response.on("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      const upstream = await fetchImplementation(
        `${omnigentBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/${operation}`,
        {
          method: request.method ?? "GET",
          headers:
            request.method === "GET"
              ? { Accept: "text/event-stream" }
              : { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
        },
      );

      response.statusCode = upstream.status;
      response.setHeader(
        "Content-Type",
        upstream.headers.get("content-type") ?? "application/octet-stream",
      );
      response.setHeader("Cache-Control", "no-store");
      if (!upstream.body) {
        response.end();
        return;
      }
      for await (const chunk of upstream.body) response.write(chunk);
      response.end();
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const status = error instanceof RequestTooLargeError ? 413 : 502;
      sendJson(response, status, {
        error: status === 413 ? "request_too_large" : "upstream_unavailable",
      });
    }
  });
}

function setCors(response: ServerResponse, origin: string): void {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type",
  );
  response.setHeader("Access-Control-Max-Age", "600");
  response.setHeader("Vary", "Origin");
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isSafeSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function hasBearerToken(request: IncomingMessage, expected: string): boolean {
  const authorization = header(request, "authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(authorization.slice(7));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_EVENT_BYTES) throw new RequestTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

class RequestTooLargeError extends Error {}
