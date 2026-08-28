import type { IncomingMessage, ServerResponse } from "node:http";

import { ResponseApiError } from "./responses/errors.js";
import type { ResponseEngine, EngineSession } from "./responses/engine.js";
import { parseResponseRequest } from "./responses/profile.js";
import type { ResponseResource } from "./responses/protocol.js";
import { encodeSseEvent, SSE_DONE } from "./responses/sse.js";

const MAX_RESPONSE_REQUEST_BYTES = 1024 * 1024;

const RESPONSES_PATH = "/v1/responses";
const AGENT_CONNECT_RESPONSE_ROUTE =
  /^\/v1\/agent-connect\/responses\/([^/]+)(?:\/(pending-function-calls|cancel))?$/;

export type ResponseRoute =
  | { readonly kind: "create" }
  | { readonly kind: "chain"; readonly responseId: string }
  | { readonly kind: "pending"; readonly responseId: string }
  | { readonly kind: "cancel"; readonly responseId: string };

/**
 * The standard endpoint plus the three Agent Connect control extensions. The
 * extensions are namespaced because Open Responses does not standardize
 * retrieval, pending-call recovery, or cancellation.
 */
export function matchResponseRoute(
  pathname: string,
): ResponseRoute | undefined {
  if (pathname === RESPONSES_PATH) return { kind: "create" };
  const match = AGENT_CONNECT_RESPONSE_ROUTE.exec(pathname);
  if (!match) return undefined;
  const responseId = decodeURIComponent(match[1] ?? "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(responseId)) return undefined;
  if (match[2] === "pending-function-calls") {
    return { kind: "pending", responseId };
  }
  if (match[2] === "cancel") return { kind: "cancel", responseId };
  return { kind: "chain", responseId };
}

export async function handleResponseRoute(
  route: ResponseRoute,
  request: IncomingMessage,
  httpResponse: ServerResponse,
  engine: ResponseEngine,
  session: EngineSession,
): Promise<void> {
  const method = request.method ?? "GET";
  const expected =
    route.kind === "create" || route.kind === "cancel" ? "POST" : "GET";
  if (method !== expected) {
    httpResponse.setHeader("Allow", expected);
    sendError(
      httpResponse,
      405,
      new ResponseApiError("invalid_request", `use ${expected} on this route`),
    );
    return;
  }

  try {
    if (route.kind === "chain") {
      const view = await engine.describeChain(session, route.responseId);
      sendJson(httpResponse, 200, {
        response_id: view.responseId,
        chain_status: view.chainStatus,
        recovery: view.recovery,
        response: view.response,
      });
      return;
    }
    if (route.kind === "pending") {
      const calls = await engine.pendingFunctionCalls(
        session,
        route.responseId,
      );
      sendJson(httpResponse, 200, {
        pending_function_calls: calls.map((call) => ({
          call_id: call.callId,
          name: call.name,
          arguments: call.arguments,
          response_id: call.responseId,
        })),
      });
      return;
    }
    if (route.kind === "cancel") {
      const view = await engine.cancelChain(session, route.responseId);
      sendJson(httpResponse, 200, {
        response_id: view.responseId,
        chain_status: view.chainStatus,
        recovery: view.recovery,
        response: view.response,
      });
      return;
    }
    await createResponse(request, httpResponse, engine, session);
  } catch (error) {
    if (httpResponse.headersSent) {
      httpResponse.end();
      return;
    }
    if (error instanceof ResponseApiError) {
      sendError(httpResponse, error.status, error);
      return;
    }
    throw error;
  }
}

async function createResponse(
  request: IncomingMessage,
  httpResponse: ServerResponse,
  engine: ResponseEngine,
  session: EngineSession,
): Promise<void> {
  const body = await readJson(request);
  const parsed = parseResponseRequest(body, session);
  // Validation and chain admission happen before any event is produced, so a
  // rejection is an ordinary HTTP failure rather than a half-written stream.
  const stream = await engine.createResponse(session, parsed);

  if (!parsed.stream) {
    let resource: ResponseResource | undefined;
    for await (const event of stream) {
      if ("response" in event) resource = event.response;
    }
    if (!resource) {
      throw new ResponseApiError(
        "backend_protocol_error",
        "the response produced no terminal event",
      );
    }
    sendJson(httpResponse, 200, resource);
    return;
  }

  httpResponse.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let responseId: string | undefined;
  let terminal = false;
  let disconnected = false;
  httpResponse.on("close", () => {
    if (terminal || httpResponse.writableEnded) return;
    disconnected = true;
    // A close during ordinary generation requests best-effort cancellation. A
    // close after a committed function boundary is the ordinary end of a
    // segment and never reaches here, because the terminal event was written.
    if (responseId) void engine.requestCancellation(responseId);
  });

  for await (const event of stream) {
    if (event.type === "response.created") responseId = event.response.id;
    if (
      event.type === "response.completed" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    ) {
      terminal = true;
    }
    if (!disconnected) httpResponse.write(encodeSseEvent(event));
  }
  if (!disconnected) {
    httpResponse.write(SSE_DONE);
    httpResponse.end();
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer);
    size += buffer.length;
    if (size > MAX_RESPONSE_REQUEST_BYTES) {
      throw new ResponseApiError(
        "invalid_request",
        "request body is too large",
      );
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ResponseApiError("invalid_request", "body must be JSON");
  }
}

function sendJson(
  httpResponse: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  httpResponse.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  httpResponse.end(body);
}

function sendError(
  httpResponse: ServerResponse,
  status: number,
  error: ResponseApiError,
): void {
  sendJson(httpResponse, status, error.toBody());
}
