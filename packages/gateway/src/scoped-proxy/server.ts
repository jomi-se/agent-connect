import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";

import { ConnectorAuth, ConnectorAuthError } from "../connector-auth.js";
import {
  DelegatedGrantError,
  type DelegatedGrantService,
  type VerifiedDelegatedGrant,
} from "../delegated-grants.js";
import { OpenClawOAuthHandler } from "../openclaw-plugin/oauth-handler.js";
import {
  ContinuationRegistry,
  ContinuationRegistryError,
  type ConversationReservation,
} from "./continuations.js";
import type { StaticOpenClawPolicySnapshot } from "./policy.js";
import {
  buildBoundedUpstreamRequest,
  MAX_RESPONSE_REQUEST_BYTES,
  ScopedProxyRequestError,
} from "./request.js";

export interface ScopedResponsesProxyOptions {
  readonly issuer: string;
  readonly resource: string;
  readonly upstreamBaseUrl: string;
  readonly upstreamToken: string;
  readonly grantService: DelegatedGrantService;
  readonly ownerAuth: ConnectorAuth;
  readonly ownerSubject?: string;
  readonly policySnapshot: Pick<
    StaticOpenClawPolicySnapshot,
    "assertUnchanged" | "assertRuntimeCurrent"
  >;
  readonly fetch?: typeof globalThis.fetch;
  readonly continuationRegistry?: ContinuationRegistry;
  readonly upstreamTimeoutMs?: number;
  readonly maxUpstreamResponseBytes?: number;
  readonly now?: () => number;
}

const OWNER_COOKIE = "agent_connect_owner";
const MAX_LOGIN_BYTES = 16 * 1024;
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const DANGEROUS_REQUEST_HEADERS = [
  "forwarded",
  "tailscale-user-login",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-openclaw-agent-id",
  "x-openclaw-message-channel",
  "x-openclaw-model",
  "x-openclaw-scopes",
  "x-openclaw-session-key",
] as const;

interface ObservedResponse {
  responseId?: string;
  readonly pendingCalls: Map<string, string>;
  terminal?: "completed" | "failed" | "incomplete";
}

export function createScopedResponsesProxy(
  options: ScopedResponsesProxyOptions,
) {
  const issuer = canonicalIssuer(options.issuer);
  if (options.resource !== `${issuer}/v1/responses`) {
    throw new TypeError(
      "resource must be the issuer's exact /v1/responses URL",
    );
  }
  const upstreamOrigin = requireLoopbackOrigin(options.upstreamBaseUrl);
  const fetchImplementation =
    options.fetch ?? globalThis.fetch.bind(globalThis);
  const registry = options.continuationRegistry ?? new ContinuationRegistry();
  const ownerSubject = options.ownerSubject ?? "local-owner";
  const now = options.now ?? Date.now;
  const ownerLoginSecret = randomBytes(32);
  const inflight = new Map<
    string,
    { readonly grantId: string; readonly controller: AbortController }
  >();
  const oauth = new OpenClawOAuthHandler({
    issuer,
    resource: options.resource,
    grantService: options.grantService,
    allowedOwnerProfileIds: [ownerSubject],
    ownerVerifier: (request) =>
      options.ownerAuth.isOwnerSession(
        cookie(request, OWNER_COOKIE),
        ownerSubject,
      )
        ? { profileId: ownerSubject, scopes: ["operator.admin"] }
        : undefined,
    now,
  });

  return createServer(async (request, response) => {
    try {
      if (!request.url || Buffer.byteLength(request.url) > 8 * 1024) {
        return sendJson(response, 414, "invalid_request", "URL is too large");
      }
      if (!request.url.startsWith("/") || request.url.startsWith("//")) {
        throw new ProxyHttpError(400, "invalid_request_target");
      }
      const url = new URL(request.url, issuer);
      if (url.pathname === "/healthz") {
        if (request.method !== "GET" || url.search)
          return methodNotAllowed(response, "GET");
        options.policySnapshot.assertUnchanged();
        await options.policySnapshot.assertRuntimeCurrent();
        return sendJsonValue(response, 200, { ok: true });
      }
      if (url.pathname === "/agent-connect/owner/login") {
        return await handleOwnerLogin(request, response, url);
      }
      if (url.pathname === "/agent-connect/oauth/authorize") {
        if (
          request.method === "GET" &&
          !options.ownerAuth.isOwnerSession(
            cookie(request, OWNER_COOKIE),
            ownerSubject,
          )
        ) {
          return showOwnerLogin(response, `${url.pathname}${url.search}`);
        }
        options.policySnapshot.assertUnchanged();
        await options.policySnapshot.assertRuntimeCurrent();
        return await oauth.handle(request, response);
      }
      if (
        url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/agent-connect/oauth/par" ||
        url.pathname === "/agent-connect/oauth/token" ||
        url.pathname === "/agent-connect/oauth/revoke"
      ) {
        return await oauth.handle(request, response);
      }
      if (url.pathname === "/v1/responses") {
        if (request.method === "OPTIONS")
          return responsePreflight(request, response);
        if (request.method !== "POST" || url.search)
          return methodNotAllowed(response, "POST, OPTIONS");
        return await handleResponses(request, response);
      }
      const cancel = url.pathname.match(
        /^\/v1\/agent-connect\/responses\/([A-Za-z0-9_.:-]{1,256})\/cancel$/,
      );
      if (cancel) {
        if (request.method === "OPTIONS")
          return responsePreflight(request, response);
        if (request.method !== "POST" || url.search)
          return methodNotAllowed(response, "POST, OPTIONS");
        return handleCancel(request, response, cancel[1] as string);
      }
      sendJson(response, 404, "not_found", "Route not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendError(response, error);
    }
  });

  async function handleResponses(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    rejectDangerousHeaders(request);
    const origin = requireBrowserOrigin(request);
    setCors(response, origin);
    requireJsonContentType(request);
    const token = requireBearer(request);
    const grant = options.grantService.verify(token, {
      resource: options.resource,
      origin,
    });
    if (!grant) throw new ProxyHttpError(401, "invalid_application_credential");
    options.policySnapshot.assertUnchanged();
    const controller = new AbortController();
    const abortOnDisconnect = () => controller.abort();
    const abortOnResponseClose = () => {
      if (!response.writableEnded) abortOnDisconnect();
    };
    request.once("aborted", abortOnDisconnect);
    response.once("close", abortOnResponseClose);
    try {
      await admitAndDispatch(request, response, origin, grant, controller);
    } catch (error) {
      if (disconnected(request, response, controller)) return;
      throw error;
    } finally {
      request.off("aborted", abortOnDisconnect);
      response.off("close", abortOnResponseClose);
    }
  }

  async function admitAndDispatch(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string,
    grant: VerifiedDelegatedGrant,
    controller: AbortController,
  ): Promise<void> {
    const value = await readJson(request, MAX_RESPONSE_REQUEST_BYTES);
    const requestedPrevious = previousResponseId(value);
    const continuation = requestedPrevious
      ? registry.peek(requestedPrevious, grant)
      : undefined;
    const bounded = buildBoundedUpstreamRequest(
      value,
      grant,
      continuation
        ? {
            responseId: continuation.responseId,
            pendingCallIds: continuation.pendingCallIds,
          }
        : undefined,
    );
    options.policySnapshot.assertUnchanged();
    await options.policySnapshot.assertRuntimeCurrent();
    if (disconnected(request, response, controller)) return;
    if (
      !options.grantService.recheck(grant, {
        applicationTools: grant.applicationTools,
      })
    ) {
      throw new ProxyHttpError(401, "grant_inactive");
    }
    if (disconnected(request, response, controller)) return;

    let reservation: ConversationReservation;
    if (requestedPrevious) {
      reservation = registry.consume(
        requestedPrevious,
        grant,
      ) as ConversationReservation;
      if (!reservation) {
        throw new ScopedProxyRequestError(
          "unknown_previous_response_id",
          "The previous response is unavailable for this grant",
        );
      }
    } else {
      reservation = registry.reserveNew(grant);
    }
    const timeout = AbortSignal.timeout(
      options.upstreamTimeoutMs ?? 30 * 60 * 1000,
    );
    const signal = AbortSignal.any([controller.signal, timeout]);
    let observedId: string | undefined;
    try {
      const upstream = await fetchImplementation(
        `${upstreamOrigin}/v1/responses`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            accept: bounded.stream ? "text/event-stream" : "application/json",
            authorization: `Bearer ${options.upstreamToken}`,
            "content-type": "application/json",
            "x-openclaw-agent-id": grant.agentId,
            "x-openclaw-session-key": reservation.sessionKey,
          },
          body: JSON.stringify(bounded.upstreamBody),
          signal,
        },
      );
      if (!upstream.ok) {
        await upstream.body?.cancel();
        throw new ProxyHttpError(502, "upstream_rejected");
      }
      if (bounded.stream) {
        observedId = await relaySse(
          upstream,
          response,
          origin,
          grant,
          reservation,
          controller,
        );
      } else {
        observedId = await relayJson(
          upstream,
          response,
          origin,
          grant,
          reservation,
        );
      }
    } catch (error) {
      for (const [responseId, active] of inflight) {
        if (active.controller !== controller) continue;
        inflight.delete(responseId);
        observedId = responseId;
      }
      registry.fail(reservation);
      if (response.headersSent) {
        if (!response.writableEnded) {
          writeProxyFailureEvent(response, observedId);
          response.end();
        }
        return;
      }
      if (signal.aborted) throw new ProxyHttpError(502, "upstream_interrupted");
      throw error;
    }
  }

  async function relayJson(
    upstream: Response,
    response: ServerResponse,
    origin: string,
    grant: VerifiedDelegatedGrant,
    reservation: ConversationReservation,
  ): Promise<string> {
    const bytes = await readWebResponse(
      upstream,
      options.maxUpstreamResponseBytes ?? 8 * 1024 * 1024,
    );
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new ProxyHttpError(502, "invalid_upstream_response");
    }
    const observed = inspectResponseObject(value, grant);
    if (!observed.responseId || observed.terminal !== "completed") {
      throw new ProxyHttpError(502, "invalid_upstream_response");
    }
    if (!registry.reserveResponseId(reservation, observed.responseId)) {
      throw new ProxyHttpError(502, "conflicting_upstream_response");
    }
    registry.complete(reservation, observed.responseId, [
      ...observed.pendingCalls.keys(),
    ]);
    setCors(response, origin);
    response.writeHead(
      200,
      safeResponseHeaders("application/json; charset=utf-8", bytes.length),
    );
    response.end(bytes);
    return observed.responseId;
  }

  async function relaySse(
    upstream: Response,
    response: ServerResponse,
    origin: string,
    grant: VerifiedDelegatedGrant,
    reservation: ConversationReservation,
    controller: AbortController,
  ): Promise<string | undefined> {
    if (!upstream.body)
      throw new ProxyHttpError(502, "invalid_upstream_response");
    setCors(response, origin);
    response.writeHead(
      200,
      safeResponseHeaders("text/event-stream; charset=utf-8"),
    );
    const observed: ObservedResponse = { pendingCalls: new Map() };
    let total = 0;
    const terminalFrames: Buffer[] = [];
    for await (const frame of sseFrames(upstream.body)) {
      total += frame.length;
      if (total > (options.maxUpstreamResponseBytes ?? 8 * 1024 * 1024)) {
        controller.abort();
        throw new ProxyHttpError(502, "upstream_response_too_large");
      }
      const event = parseSseData(frame);
      if (observed.terminal && event) {
        controller.abort();
        throw new ProxyHttpError(502, "invalid_upstream_sse");
      }
      if (event) inspectEvent(event, grant, observed);
      if (observed.responseId && !inflight.has(observed.responseId)) {
        if (!registry.reserveResponseId(reservation, observed.responseId)) {
          controller.abort();
          throw new ProxyHttpError(502, "conflicting_upstream_response");
        }
        inflight.set(observed.responseId, {
          grantId: grant.grantId,
          controller,
        });
      }
      if (observed.terminal) {
        terminalFrames.push(frame);
      } else {
        await writeWithBackpressure(response, frame);
      }
    }
    if (!observed.terminal || !observed.responseId) {
      throw new ProxyHttpError(502, "upstream_stream_ended");
    }
    if (observed.terminal === "completed") {
      registry.complete(reservation, observed.responseId, [
        ...observed.pendingCalls.keys(),
      ]);
      for (const frame of terminalFrames) {
        await writeWithBackpressure(response, frame);
      }
    } else {
      registry.fail(reservation);
      writeProxyFailureEvent(response, observed.responseId);
    }
    response.end();
    inflight.delete(observed.responseId);
    return observed.responseId;
  }

  function handleCancel(
    request: IncomingMessage,
    response: ServerResponse,
    responseId: string,
  ): void {
    rejectDangerousHeaders(request);
    const origin = requireBrowserOrigin(request);
    setCors(response, origin);
    const grant = authenticate(request, origin);
    const active = inflight.get(responseId);
    if (!active || active.grantId !== grant.grantId) {
      throw new ProxyHttpError(404, "response_not_found");
    }
    inflight.delete(responseId);
    active.controller.abort();
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
  }

  function authenticate(
    request: IncomingMessage,
    origin: string,
  ): VerifiedDelegatedGrant {
    const grant = options.grantService.verify(requireBearer(request), {
      resource: options.resource,
      origin,
    });
    if (!grant) throw new ProxyHttpError(401, "invalid_application_credential");
    options.policySnapshot.assertUnchanged();
    if (!options.grantService.recheck(grant)) {
      throw new ProxyHttpError(401, "grant_inactive");
    }
    return grant;
  }

  function showOwnerLogin(response: ServerResponse, returnTo: string): void {
    const challenge = signOwnerLoginChallenge(ownerLoginSecret, {
      returnTo,
      expiresAt: now() + 10 * 60 * 1000,
    });
    sendHtml(
      response,
      401,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Owner sign in</title></head><body><main><h1>Owner sign in</h1><p>Enter the gateway enrollment secret to review this request.</p><form method="post" action="/agent-connect/owner/login"><input type="hidden" name="challenge" value="${challenge}"><label>Enrollment secret <input type="password" name="passphrase" autocomplete="current-password" required></label><button type="submit">Continue</button></form></main></body></html>`,
    );
  }

  async function handleOwnerLogin(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.method !== "POST" || url.search)
      return methodNotAllowed(response, "POST");
    if (singleHeader(request, "origin") !== issuer) {
      throw new ProxyHttpError(403, "owner_login_origin_mismatch");
    }
    const contentType = singleHeader(request, "content-type")?.split(";", 1)[0];
    if (contentType !== "application/x-www-form-urlencoded") {
      throw new ProxyHttpError(400, "invalid_owner_login");
    }
    const form = new URLSearchParams(
      (await readBytes(request, MAX_LOGIN_BYTES)).toString("utf8"),
    );
    if (
      [...new Set(form.keys())].sort().join("\0") !== "challenge\0passphrase"
    ) {
      throw new ProxyHttpError(400, "invalid_owner_login");
    }
    const challengeId = singleFormValue(form, "challenge");
    const challenge = verifyOwnerLoginChallenge(ownerLoginSecret, challengeId);
    if (!challenge || challenge.expiresAt <= now()) {
      throw new ProxyHttpError(400, "owner_login_expired");
    }
    try {
      const token = await options.ownerAuth.enrollOwnerSession(
        singleFormValue(form, "passphrase"),
        ownerSubject,
      );
      response.setHeader(
        "set-cookie",
        `${OWNER_COOKIE}=${encodeURIComponent(token)}; Path=/agent-connect/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`,
      );
      response.writeHead(303, {
        location: challenge.returnTo,
        "cache-control": "no-store",
      });
      response.end();
    } catch (error) {
      if (error instanceof ConnectorAuthError) {
        throw new ProxyHttpError(
          error.code === "enrollment_locked" ? 429 : 403,
          "owner_login_failed",
        );
      }
      throw error;
    }
  }
}

function signOwnerLoginChallenge(
  secret: Buffer,
  value: { readonly returnTo: string; readonly expiresAt: number },
): string {
  const payload = Buffer.from(
    JSON.stringify({
      ...value,
      nonce: randomBytes(18).toString("base64url"),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifyOwnerLoginChallenge(
  secret: Buffer,
  token: string,
): { readonly returnTo: string; readonly expiresAt: number } | undefined {
  if (token.length > 4096) return undefined;
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [payload, supplied] = parts as [string, string];
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return undefined;
  }
  try {
    const value = record(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    if (
      !value ||
      typeof value.returnTo !== "string" ||
      !value.returnTo.startsWith("/agent-connect/oauth/authorize?") ||
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.expiresAt)
    ) {
      return undefined;
    }
    return { returnTo: value.returnTo, expiresAt: value.expiresAt };
  } catch {
    return undefined;
  }
}

function inspectEvent(
  event: Record<string, unknown>,
  grant: VerifiedDelegatedGrant,
  observed: ObservedResponse,
): void {
  const type = event.type;
  const response = record(event.response);
  const id = typeof response?.id === "string" ? response.id : undefined;
  if (type === "response.created") setObservedId(observed, id);
  if (event.item !== undefined) {
    inspectFunctionCall(event.item, grant, observed.pendingCalls);
  }
  if (type === "response.completed") {
    setObservedId(observed, id);
    inspectOutput(response?.output, grant, observed.pendingCalls);
    observed.terminal = "completed";
  } else if (type === "response.failed") {
    setObservedId(observed, id);
    observed.terminal = "failed";
  } else if (type === "response.incomplete") {
    setObservedId(observed, id);
    observed.terminal = "incomplete";
  }
}

function inspectResponseObject(
  value: unknown,
  grant: VerifiedDelegatedGrant,
): ObservedResponse {
  const response = record(value);
  const observed: ObservedResponse = { pendingCalls: new Map() };
  if (!response || typeof response.id !== "string") return observed;
  setObservedId(observed, response.id);
  inspectOutput(response.output, grant, observed.pendingCalls);
  if (response.status === "completed") observed.terminal = "completed";
  else if (response.status === "failed") observed.terminal = "failed";
  else if (response.status === "incomplete") observed.terminal = "incomplete";
  return observed;
}

function inspectOutput(
  value: unknown,
  grant: VerifiedDelegatedGrant,
  calls: Map<string, string>,
): void {
  if (!Array.isArray(value)) return;
  for (const item of value) inspectFunctionCall(item, grant, calls);
}

function inspectFunctionCall(
  value: unknown,
  grant: VerifiedDelegatedGrant,
  calls: Map<string, string>,
): void {
  const item = record(value);
  if (!item || item.type !== "function_call") return;
  if (
    typeof item.name !== "string" ||
    !grant.applicationTools.some((tool) => tool.name === item.name) ||
    typeof item.call_id !== "string" ||
    item.call_id.length === 0 ||
    item.call_id.length > 256
  ) {
    throw new ProxyHttpError(502, "unapproved_upstream_tool");
  }
  const previous = calls.get(item.call_id);
  if (previous !== undefined && previous !== item.name) {
    throw new ProxyHttpError(502, "conflicting_upstream_response");
  }
  calls.set(item.call_id, item.name);
}

function setObservedId(
  observed: ObservedResponse,
  value: string | undefined,
): void {
  if (!value || value.length > 256 || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new ProxyHttpError(502, "invalid_upstream_response");
  }
  if (observed.responseId && observed.responseId !== value) {
    throw new ProxyHttpError(502, "conflicting_upstream_response");
  }
  observed.responseId = value;
}

async function* sseFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Buffer> {
  const reader = stream.getReader();
  let buffered = Buffer.alloc(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffered = Buffer.concat([buffered, Buffer.from(value)]);
      for (;;) {
        const boundary = findSseBoundary(buffered);
        if (!boundary) break;
        const length = boundary.index + boundary.size;
        if (length > MAX_SSE_EVENT_BYTES) {
          throw new ProxyHttpError(502, "upstream_event_too_large");
        }
        const frame = buffered.subarray(0, length);
        buffered = buffered.subarray(length);
        yield frame;
      }
      if (buffered.length > MAX_SSE_EVENT_BYTES) {
        throw new ProxyHttpError(502, "upstream_event_too_large");
      }
      if (done) break;
    }
    if (buffered.length > 0)
      throw new ProxyHttpError(502, "invalid_upstream_sse");
  } finally {
    reader.releaseLock();
  }
}

async function writeWithBackpressure(
  response: ServerResponse,
  value: Buffer,
): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    throw new ProxyHttpError(502, "upstream_interrupted");
  }
  if (response.write(value)) return;
  await Promise.race([
    once(response, "drain"),
    once(response, "close").then(() => {
      throw new ProxyHttpError(502, "upstream_interrupted");
    }),
  ]);
}

function findSseBoundary(
  value: Buffer,
): { index: number; size: number } | undefined {
  const crlf = value.indexOf("\r\n\r\n");
  const lf = value.indexOf("\n\n");
  if (crlf < 0 && lf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { index: crlf, size: 4 };
  return { index: lf, size: 2 };
}

function parseSseData(frame: Buffer): Record<string, unknown> | undefined {
  const data = frame
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return undefined;
  try {
    const value = JSON.parse(data);
    const parsed = record(value);
    if (!parsed) throw new Error();
    return parsed;
  } catch {
    throw new ProxyHttpError(502, "invalid_upstream_sse");
  }
}

function writeProxyFailureEvent(
  response: ServerResponse,
  responseId?: string,
): void {
  response.write(
    `data: ${JSON.stringify({
      type: "response.failed",
      response: {
        id: responseId ?? "",
        status: "failed",
        error: {
          type: "server_error",
          code: "proxy_interrupted",
          message:
            "The private upstream response was interrupted; it was not replayed.",
        },
      },
    })}\n\n`,
  );
}

function previousResponseId(value: unknown): string | undefined {
  const body = record(value);
  return typeof body?.previous_response_id === "string"
    ? body.previous_response_id
    : undefined;
}

function disconnected(
  request: IncomingMessage,
  response: ServerResponse,
  controller: AbortController,
): boolean {
  return controller.signal.aborted || request.aborted || response.destroyed;
}

async function readJson(
  request: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const bytes = await readBytes(request, limit);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ScopedProxyRequestError(
      "invalid_request",
      "Body must be valid JSON",
    );
  }
}

async function readBytes(
  request: IncomingMessage,
  limit: number,
): Promise<Buffer> {
  const declared = Number(singleHeader(request, "content-length") ?? 0);
  if (!Number.isFinite(declared) || declared > limit) {
    throw new ProxyHttpError(413, "request_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > limit) throw new ProxyHttpError(413, "request_too_large");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readWebResponse(
  response: Response,
  limit: number,
): Promise<Buffer> {
  if (!response.body)
    throw new ProxyHttpError(502, "invalid_upstream_response");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.length;
      if (size > limit)
        throw new ProxyHttpError(502, "upstream_response_too_large");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

function responsePreflight(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const origin = singleHeader(request, "origin");
  const method = singleHeader(request, "access-control-request-method");
  const headers = (
    singleHeader(request, "access-control-request-headers") ?? ""
  )
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (
    !origin ||
    !isCanonicalHttpsOrigin(origin) ||
    method !== "POST" ||
    headers.some(
      (header) => !["authorization", "content-type", "accept"].includes(header),
    )
  ) {
    throw new ProxyHttpError(403, "invalid_preflight");
  }
  setCors(response, origin);
  response.writeHead(204, {
    "access-control-allow-methods": "POST",
    "access-control-allow-headers": "authorization, content-type, accept",
    "access-control-max-age": "600",
  });
  response.end();
}

function rejectDangerousHeaders(request: IncomingMessage): void {
  for (const name of DANGEROUS_REQUEST_HEADERS) {
    if (request.headers[name] !== undefined) {
      throw new ScopedProxyRequestError(
        "invalid_request",
        `Caller-controlled routing header is forbidden: ${name}`,
      );
    }
  }
}

function requireJsonContentType(request: IncomingMessage): void {
  const type = singleHeader(request, "content-type")?.split(";", 1)[0]?.trim();
  if (type !== "application/json") {
    throw new ScopedProxyRequestError(
      "invalid_request",
      "Content-Type must be application/json",
    );
  }
}

function requireBrowserOrigin(request: IncomingMessage): string {
  const origin = singleHeader(request, "origin");
  if (!origin || !isCanonicalHttpsOrigin(origin)) {
    throw new ProxyHttpError(403, "browser_origin_required");
  }
  return origin;
}

function requireBearer(request: IncomingMessage): string {
  const authorization = singleHeader(request, "authorization");
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
  if (!match) throw new ProxyHttpError(401, "invalid_application_credential");
  return match[1] as string;
}

function singleHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const values = request.headersDistinct[name];
  if (!values) return undefined;
  if (values.length !== 1) throw new ProxyHttpError(400, "conflicting_headers");
  return values[0];
}

function cookie(request: IncomingMessage, name: string): string | undefined {
  const header = singleHeader(request, "cookie");
  for (const item of header?.split(";") ?? []) {
    const index = item.indexOf("=");
    if (index < 0 || item.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function singleFormValue(form: URLSearchParams, name: string): string {
  const values = form.getAll(name);
  if (values.length !== 1 || !values[0]) {
    throw new ProxyHttpError(400, "invalid_owner_login");
  }
  return values[0];
}

function canonicalIssuer(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    value !== url.origin ||
    url.username ||
    url.password
  ) {
    throw new TypeError("issuer must be a canonical HTTPS origin");
  }
  return value;
}

function requireLoopbackOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    value !== url.origin ||
    !url.port ||
    url.username ||
    url.password
  ) {
    throw new TypeError(
      "stock OpenClaw upstream must be an explicit loopback HTTP origin",
    );
  }
  return value;
}

function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      value === url.origin &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function safeResponseHeaders(
  contentType: string,
  length?: number,
): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(length === undefined ? {} : { "content-length": String(length) }),
  };
}

function setCors(response: ServerResponse, origin: string): void {
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
}

function sendHtml(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, {
    ...safeResponseHeaders("text/html; charset=utf-8", Buffer.byteLength(body)),
    "content-security-policy":
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader("allow", allow);
  sendJson(response, 405, "method_not_allowed", "Method not allowed");
}

function sendJson(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  if (status === 401) response.setHeader("www-authenticate", "Bearer");
  sendJsonValue(response, status, {
    error: { type: "invalid_request_error", code, message },
  });
}

function sendJsonValue(
  response: ServerResponse,
  status: number,
  value: Readonly<Record<string, unknown>>,
): void {
  const body = JSON.stringify(value);
  response.writeHead(
    status,
    safeResponseHeaders(
      "application/json; charset=utf-8",
      Buffer.byteLength(body),
    ),
  );
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof ProxyHttpError) {
    sendJson(response, error.status, error.code, publicMessage(error.code));
  } else if (error instanceof ScopedProxyRequestError) {
    sendJson(response, 400, error.code, error.message);
  } else if (error instanceof ContinuationRegistryError) {
    sendJson(response, 429, error.code, publicMessage(error.code));
  } else if (error instanceof DelegatedGrantError) {
    sendJson(response, 400, error.code, publicMessage(error.code));
  } else {
    sendJson(
      response,
      503,
      "proxy_unavailable",
      publicMessage("proxy_unavailable"),
    );
  }
}

function publicMessage(code: string): string {
  if (code === "upstream_interrupted") {
    return "The private upstream outcome is uncertain; the request was not replayed.";
  }
  if (code === "unknown_previous_response_id") {
    return "The previous response is unavailable for this grant.";
  }
  return "The scoped Responses request could not be completed.";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

class ProxyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
