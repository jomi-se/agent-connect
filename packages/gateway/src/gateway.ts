import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  createPairingCode,
  issueCapability,
  safeEqual,
  verifyCapability,
  type CapabilityClaims,
} from "./capability.js";
import { OmnigentRuntime } from "./omnigent-runtime.js";
import type { AgentRuntime } from "./runtime.js";
import {
  hashOmnigentToolEnvelope,
  hashToolSnapshot,
  InvalidToolSnapshotError,
  validateToolSnapshot,
  type GatewayToolDefinition,
} from "./tool-snapshot.js";

export interface GatewayOptions {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowedTailscaleUsers: ReadonlySet<string>;
  readonly omnigentBaseUrl: string;
  readonly workspace?: string;
  readonly omnigentHostId?: string;
  readonly accessToken?: string;
  readonly pairingCode?: string;
  readonly pairingCodeTtlSeconds?: number;
  readonly capabilitySigningSecret?: string;
  readonly capabilityTtlSeconds?: number;
  readonly runtime?: AgentRuntime;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly onPairingCodeGenerated?: (code: string, expiresAt: string) => void;
}

interface ManagedSession {
  readonly id: string;
  readonly appId: string;
  readonly origin: string;
  readonly toolHash: string;
  providerSessionId: string;
}

const PROVIDER_SESSION_ROUTE = /^\/v1\/sessions\/([^/]+)\/(stream|events)$/;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_CREATE_BYTES = 64 * 1024;

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
  const runtime =
    options.runtime ??
    new OmnigentRuntime({
      baseUrl: omnigentBaseUrl,
      workspace: options.workspace ?? process.cwd(),
      ...(options.omnigentHostId ? { hostId: options.omnigentHostId } : {}),
      fetch: fetchImplementation,
    });
  const now = options.now ?? Date.now;
  const pairingTtl = options.pairingCodeTtlSeconds ?? 10 * 60;
  const capabilityTtl = options.capabilityTtlSeconds ?? 60 * 60;
  const signingSecret =
    options.capabilitySigningSecret ?? randomBytes(32).toString("base64url");
  const managedSessions = new Map<string, ManagedSession>();
  const sessionsByKey = new Map<string, ManagedSession>();
  const pendingSessions = new Map<string, Promise<ManagedSession>>();
  const pendingRepairs = new Map<string, Promise<ManagedSession>>();
  let pairing = newPairing(options.pairingCode ?? createPairingCode());

  options.onPairingCodeGenerated?.(pairing.code, iso(pairing.expiresAt));

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

      const pathname = new URL(request.url ?? "/", "http://gateway.invalid")
        .pathname;

      if (pathname === "/v1/app-sessions") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const input = await readCreateRequest(request);
        const authorization = header(request, "authorization") ?? "";
        const existingClaims = bearerClaims(
          authorization,
          signingSecret,
          Math.floor(now() / 1000),
        );
        let session: ManagedSession;

        if (existingClaims) {
          session = requireExistingSession(
            existingClaims,
            input,
            origin,
            managedSessions,
          );
          session = await ensureHealthy(session);
        } else {
          const submittedCode = pairingCredential(authorization);
          if (
            !submittedCode ||
            pairing.expiresAt <= now() ||
            !safeEqual(submittedCode, pairing.code)
          ) {
            if (pairing.expiresAt <= now()) rotatePairing();
            response.setHeader("WWW-Authenticate", "Pairing");
            sendJson(response, 401, { error: "invalid_pairing_code" });
            return;
          }

          // Reserve and rotate before the asynchronous provider launch so one
          // credential can authorize at most one exchange, even under races.
          rotatePairing();
          session = await getOrCreateSession(input, origin);
        }

        const issuedAt = Math.floor(now() / 1000);
        const expiresAt = issuedAt + capabilityTtl;
        const accessToken = issueCapability(
          {
            appId: session.appId,
            origin: session.origin,
            sessionId: session.id,
            toolHash: session.toolHash,
            issuedAt,
            expiresAt,
          },
          signingSecret,
        );
        sendJson(response, 201, {
          sessionId: session.id,
          accessToken,
          expiresAt: new Date(expiresAt * 1000).toISOString(),
          toolHash: session.toolHash,
        });
        return;
      }

      const match = PROVIDER_SESSION_ROUTE.exec(pathname);
      if (!match) {
        sendJson(response, 404, { error: "route_not_found" });
        return;
      }
      const requestedId = decodeURIComponent(match[1] ?? "");
      const operation = match[2];
      if (!isSafeSessionId(requestedId)) {
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

      const managed = managedSessions.get(requestedId);
      let providerSessionId = requestedId;
      let body: string | undefined;
      if (managed) {
        const claims = bearerClaims(
          header(request, "authorization") ?? "",
          signingSecret,
          Math.floor(now() / 1000),
        );
        if (!claims || !claimsMatchSession(claims, managed, origin)) {
          response.setHeader("WWW-Authenticate", "Bearer");
          sendJson(response, 401, { error: "invalid_session_capability" });
          return;
        }
        if (request.method === "GET") {
          providerSessionId = (await ensureHealthy(managed)).providerSessionId;
        } else {
          body = await readBody(request, MAX_EVENT_BYTES);
          if (!eventMatchesToolSnapshot(body, managed.toolHash)) {
            sendJson(response, 403, { error: "tool_snapshot_mismatch" });
            return;
          }
          providerSessionId = managed.providerSessionId;
        }
      } else {
        if (!options.accessToken) {
          sendJson(response, 404, { error: "session_not_found" });
          return;
        }
        if (!hasBearerToken(request, options.accessToken)) {
          response.setHeader("WWW-Authenticate", "Bearer");
          sendJson(response, 401, { error: "invalid_session_capability" });
          return;
        }
        body =
          request.method === "POST"
            ? await readBody(request, MAX_EVENT_BYTES)
            : undefined;
      }

      const controller = new AbortController();
      response.on("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      const upstream = await fetchImplementation(
        `${omnigentBaseUrl}/v1/sessions/${encodeURIComponent(providerSessionId)}/${operation}`,
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
      if (error instanceof RequestTooLargeError) {
        sendJson(response, 413, { error: "request_too_large" });
      } else if (
        error instanceof InvalidRequestError ||
        error instanceof InvalidToolSnapshotError
      ) {
        sendJson(response, 400, {
          error: "invalid_request",
          message: error.message,
        });
      } else if (error instanceof InvalidCapabilityError) {
        sendJson(response, 401, { error: "invalid_session_capability" });
      } else {
        sendJson(response, 502, { error: "upstream_unavailable" });
      }
    }
  });

  function newPairing(code: string): { code: string; expiresAt: number } {
    return { code, expiresAt: now() + pairingTtl * 1000 };
  }

  function rotatePairing(): void {
    pairing = newPairing(createPairingCode());
    options.onPairingCodeGenerated?.(pairing.code, iso(pairing.expiresAt));
  }

  async function getOrCreateSession(
    input: CreateSessionInput,
    origin: string,
  ): Promise<ManagedSession> {
    const key = sessionKey(origin, input.appId, input.toolHash);
    const pending = pendingSessions.get(key);
    if (pending) return pending;
    const operation = (async () => {
      const existing = sessionsByKey.get(key);
      if (existing) return ensureHealthy(existing);
      const providerSessionId = await runtime.createSession({
        appId: input.appId,
        origin,
        toolHash: input.toolHash,
      });
      const created: ManagedSession = {
        id: `acs_${randomUUID()}`,
        appId: input.appId,
        origin,
        toolHash: input.toolHash,
        providerSessionId,
      };
      managedSessions.set(created.id, created);
      sessionsByKey.set(key, created);
      return created;
    })();
    pendingSessions.set(key, operation);
    try {
      return await operation;
    } finally {
      pendingSessions.delete(key);
    }
  }

  async function ensureHealthy(
    session: ManagedSession,
  ): Promise<ManagedSession> {
    const pending = pendingRepairs.get(session.id);
    if (pending) return pending;
    if (await runtime.isHealthy(session.providerSessionId)) return session;
    const raced = pendingRepairs.get(session.id);
    if (raced) return raced;
    const repair = (async () => {
      session.providerSessionId = await runtime.createSession({
        appId: session.appId,
        origin: session.origin,
        toolHash: session.toolHash,
      });
      return session;
    })();
    pendingRepairs.set(session.id, repair);
    try {
      return await repair;
    } finally {
      pendingRepairs.delete(session.id);
    }
  }
}

interface CreateSessionInput {
  readonly appId: string;
  readonly tools: readonly GatewayToolDefinition[];
  readonly toolHash: string;
}

async function readCreateRequest(
  request: IncomingMessage,
): Promise<CreateSessionInput> {
  const raw = await readBody(request, MAX_CREATE_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InvalidRequestError("request body must be JSON");
  }
  if (!isRecord(value))
    throw new InvalidRequestError("request must be an object");
  const appId = value["appId"];
  if (
    typeof appId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(appId)
  ) {
    throw new InvalidRequestError("appId is invalid");
  }
  const tools = validateToolSnapshot(value["tools"]);
  return { appId, tools, toolHash: hashToolSnapshot(tools) };
}

function requireExistingSession(
  claims: CapabilityClaims,
  input: CreateSessionInput,
  origin: string,
  sessions: ReadonlyMap<string, ManagedSession>,
): ManagedSession {
  const session = sessions.get(claims.sessionId);
  if (
    !session ||
    claims.origin !== origin ||
    claims.appId !== input.appId ||
    claims.toolHash !== input.toolHash ||
    !claimsMatchSession(claims, session, origin)
  ) {
    throw new InvalidCapabilityError();
  }
  return session;
}

function claimsMatchSession(
  claims: CapabilityClaims,
  session: ManagedSession,
  origin: string,
): boolean {
  return (
    claims.origin === origin &&
    claims.origin === session.origin &&
    claims.appId === session.appId &&
    claims.sessionId === session.id &&
    claims.toolHash === session.toolHash
  );
}

function eventMatchesToolSnapshot(body: string, expectedHash: string): boolean {
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return false;
  }
  if (!isRecord(event)) return false;
  if (event["type"] !== "message") return true;
  return hashOmnigentToolEnvelope(event["tools"]) === expectedHash;
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

function pairingCredential(authorization: string): string | undefined {
  return authorization.startsWith("Pairing ")
    ? authorization.slice("Pairing ".length)
    : undefined;
}

function bearerClaims(
  authorization: string,
  signingSecret: string,
  nowSeconds: number,
): CapabilityClaims | undefined {
  return authorization.startsWith("Bearer ")
    ? verifyCapability(
        authorization.slice("Bearer ".length),
        signingSecret,
        nowSeconds,
      )
    : undefined;
}

function hasBearerToken(request: IncomingMessage, expected: string): boolean {
  const authorization = header(request, "authorization");
  return Boolean(
    authorization?.startsWith("Bearer ") &&
    safeEqual(authorization.slice(7), expected),
  );
}

async function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new RequestTooLargeError();
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

function sessionKey(origin: string, appId: string, toolHash: string): string {
  return `${origin}\n${appId}\n${toolHash}`;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RequestTooLargeError extends Error {}
class InvalidRequestError extends Error {}
class InvalidCapabilityError extends Error {}
