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
import {
  authorizationRedirect,
  ConnectorAuth,
  ConnectorAuthError,
  type EnrollmentBundle,
  type PendingAuthorization,
} from "./connector-auth.js";
import { OmnigentRuntime } from "./omnigent-runtime.js";
import type { OmnigentSandboxOptions } from "./omnigent-runtime.js";
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
  readonly dynamicAppEnrollment?: boolean;
  readonly allowedTailscaleUsers: ReadonlySet<string>;
  readonly omnigentBaseUrl: string;
  readonly workspace?: string;
  readonly omnigentHostId?: string;
  readonly omnigentSandbox?: OmnigentSandboxOptions;
  readonly accessToken?: string;
  readonly pairingCode?: string;
  readonly pairingCodeTtlSeconds?: number;
  readonly capabilitySigningSecret?: string;
  readonly capabilityTtlSeconds?: number;
  readonly authStatePath?: string;
  readonly publicEndpoint?: string;
  readonly transportProfile?: string;
  readonly publicDemoAuthorities?: readonly {
    readonly appId: string;
    readonly redirectUri: string;
    readonly toolHash: string;
  }[];
  readonly enrollmentPassphrase?: string;
  readonly runtime?: AgentRuntime;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly onPairingCodeGenerated?: (code: string, expiresAt: string) => void;
  readonly onEnrollmentBundle?: (bundle: EnrollmentBundle) => void;
}

interface ManagedSession {
  readonly id: string;
  readonly appId: string;
  readonly origin: string;
  readonly toolHash: string;
  readonly approvedToolNames: readonly string[];
  readonly authorizationGrantId?: string;
  providerSessionId: string;
}

const PROVIDER_SESSION_ROUTE = /^\/v1\/sessions\/([^/]+)\/(stream|events)$/;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_CREATE_BYTES = 64 * 1024;
const DEVICE_COOKIE = "agent_connect_device";
const PUBLIC_DEMO_PROFILE = "public-demo";
const PUBLIC_DEMO_PRINCIPAL = "agent-connect-public-demo";

export function createGateway(options: GatewayOptions) {
  const publicDemo = options.transportProfile === PUBLIC_DEMO_PROFILE;
  const dynamicAppEnrollment = options.dynamicAppEnrollment === true;
  if (options.allowedOrigins.size === 0 && !dynamicAppEnrollment) {
    throw new TypeError("At least one allowed browser origin is required");
  }
  if (
    dynamicAppEnrollment &&
    (publicDemo || options.transportProfile !== "tailscale-serve")
  ) {
    throw new TypeError(
      "dynamic app enrollment requires the tailscale-serve transport profile",
    );
  }
  if (dynamicAppEnrollment && !options.authStatePath) {
    throw new TypeError(
      "dynamic app enrollment requires gateway authorization state",
    );
  }
  if (!publicDemo && options.allowedTailscaleUsers.size === 0) {
    throw new TypeError("At least one allowed Tailscale login is required");
  }
  if (publicDemo && !options.publicDemoAuthorities?.length) {
    throw new TypeError(
      "public-demo requires an exact configured application authority",
    );
  }
  if (!publicDemo && options.publicDemoAuthorities?.length) {
    throw new TypeError(
      "publicDemoAuthorities is valid only for the public-demo profile",
    );
  }
  const publicEndpoint = options.publicEndpoint
    ? canonicalPublicEndpoint(options.publicEndpoint)
    : undefined;

  const fetchImplementation =
    options.fetch ?? globalThis.fetch.bind(globalThis);
  const omnigentBaseUrl = options.omnigentBaseUrl.replace(/\/$/, "");
  const runtime =
    options.runtime ??
    new OmnigentRuntime({
      baseUrl: omnigentBaseUrl,
      workspace: options.workspace ?? process.cwd(),
      ...(options.omnigentHostId ? { hostId: options.omnigentHostId } : {}),
      ...(options.omnigentSandbox ? { sandbox: options.omnigentSandbox } : {}),
      fetch: fetchImplementation,
    });
  const now = options.now ?? Date.now;
  if (Boolean(options.authStatePath) !== Boolean(publicEndpoint)) {
    throw new TypeError(
      "authStatePath and publicEndpoint must be configured together",
    );
  }
  const connectorAuth =
    options.authStatePath && publicEndpoint
      ? new ConnectorAuth({
          statePath: options.authStatePath,
          publicEndpoint,
          ...(options.transportProfile
            ? { transportProfile: options.transportProfile }
            : {}),
          ...(options.enrollmentPassphrase
            ? { enrollmentPassphrase: options.enrollmentPassphrase }
            : {}),
          now,
          ...(options.onEnrollmentBundle
            ? { onEnrollmentBundle: options.onEnrollmentBundle }
            : {}),
        })
      : undefined;
  const pairingTtl = options.pairingCodeTtlSeconds ?? 10 * 60;
  const capabilityTtl = options.capabilityTtlSeconds ?? 60 * 60;
  const signingSecret =
    options.capabilitySigningSecret ??
    connectorAuth?.capabilitySigningSecret ??
    randomBytes(32).toString("base64url");
  const managedSessions = new Map<string, ManagedSession>();
  const sessionsByKey = new Map<string, ManagedSession>();
  const pendingSessions = new Map<string, Promise<ManagedSession>>();
  const pendingRepairs = new Map<string, Promise<ManagedSession>>();
  // OAuth-style grants replace the spike's terminal pairing code. Keeping both
  // enabled would leave a consent-bypass path in an otherwise enrolled runtime.
  const legacyPairingEnabled = connectorAuth === undefined;
  let pairing = newPairing(options.pairingCode ?? createPairingCode());

  if (legacyPairingEnabled) {
    options.onPairingCodeGenerated?.(pairing.code, iso(pairing.expiresAt));
  }

  return createServer(async (request, response) => {
    try {
      if (request.url === "/healthz" && request.method === "GET") {
        sendJson(response, 200, { ok: true });
        return;
      }

      const pathname = new URL(request.url ?? "/", "http://gateway.invalid")
        .pathname;

      if (
        connectorAuth &&
        (pathname === "/authorize" || pathname === "/v1/grants")
      ) {
        const principal = requireTransportPrincipal(
          request,
          response,
          options.allowedTailscaleUsers,
          publicDemo,
        );
        if (!principal) return;
        if (pathname === "/authorize") {
          await handleAuthorizationPage(
            request,
            response,
            connectorAuth,
            principal,
            publicEndpoint ?? "",
          );
        } else {
          if (
            publicDemo &&
            !connectorAuth.isDeviceEnrolled(
              cookie(request, DEVICE_COOKIE),
              principal,
            )
          ) {
            sendJson(response, 401, { error: "device_not_enrolled" });
            return;
          }
          await handleGrantPage(
            request,
            response,
            connectorAuth,
            publicEndpoint ?? "",
          );
        }
        return;
      }

      const origin = header(request, "origin");
      if (
        !origin ||
        (!options.allowedOrigins.has(origin) &&
          !(dynamicAppEnrollment && isDynamicApplicationOrigin(origin)))
      ) {
        sendJson(response, 403, { error: "origin_not_allowed" });
        return;
      }
      setCors(response, origin);

      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      const principal = requireTransportPrincipal(
        request,
        response,
        options.allowedTailscaleUsers,
        publicDemo,
      );
      if (!principal) return;

      if (connectorAuth && pathname === "/v1/runtime-challenges") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const value = await readJsonObject(request, MAX_CREATE_BYTES);
        const nonce = value["nonce"];
        if (typeof nonce !== "string") {
          throw new InvalidRequestError("nonce is required");
        }
        sendJson(response, 200, { ...connectorAuth.createChallenge(nonce) });
        return;
      }

      if (connectorAuth && pathname === "/v1/authorization-requests") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const value = await readJsonObject(request, MAX_CREATE_BYTES);
        const appId = requireString(value, "appId");
        const redirectUri = requireString(value, "redirectUri");
        const tools = validateToolSnapshot(value["tools"]);
        if (
          publicDemo &&
          !matchesPublicDemoAuthority(
            { appId, redirectUri, toolHash: hashToolSnapshot(tools) },
            options.publicDemoAuthorities,
          )
        ) {
          sendJson(response, 403, { error: "public_demo_authority_mismatch" });
          return;
        }
        const authorization = connectorAuth.createAuthorizationRequest({
          origin,
          appId,
          redirectUri,
          state: requireString(value, "state"),
          codeChallenge: requireString(value, "codeChallenge"),
          scopes: requireStringArray(value, "scopes"),
          tools,
        });
        sendJson(response, 201, {
          requestId: authorization.id,
          authorizeUrl: `${publicEndpoint}/authorize?request=${encodeURIComponent(authorization.id)}`,
          expiresAt: iso(authorization.expiresAt),
        });
        return;
      }

      if (connectorAuth && pathname === "/oauth/token") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const value = await readJsonObject(request, MAX_CREATE_BYTES);
        const exchanged = connectorAuth.exchangeCode({
          code: requireString(value, "code"),
          codeVerifier: requireString(value, "codeVerifier"),
          origin,
          appId: requireString(value, "appId"),
          redirectUri: requireString(value, "redirectUri"),
        });
        sendJson(response, 200, {
          accessToken: exchanged.accessToken,
          tokenType: "Bearer",
          expiresAt: exchanged.grant.expiresAt,
          grant: exchanged.grant,
        });
        return;
      }

      if (connectorAuth && pathname === "/oauth/revoke") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const value = await readJsonObject(request, MAX_CREATE_BYTES);
        const token = bearerCredential(header(request, "authorization") ?? "");
        if (token) {
          connectorAuth.revokeGrantByToken(token, {
            origin,
            appId: requireString(value, "appId"),
          });
        }
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
        return;
      }

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
          if (
            session.authorizationGrantId &&
            !connectorAuth?.isGrantActive(session.authorizationGrantId)
          ) {
            sendJson(response, 401, { error: "grant_revoked" });
            return;
          }
          session = await ensureHealthy(session);
        } else {
          const bearer = bearerCredential(authorization);
          const grant =
            bearer && connectorAuth
              ? connectorAuth.verifyGrant(bearer, {
                  origin,
                  appId: input.appId,
                  toolHash: input.toolHash,
                  scopes: ["agent:prompt", "agent:result", "tools:invoke"],
                })
              : undefined;
          if (grant) {
            session = await getOrCreateSession(input, origin, grant.id);
          } else if (legacyPairingEnabled) {
            const submittedCode = pairingCredential(authorization);
            if (
              !submittedCode ||
              pairing.expiresAt <= now() ||
              !safeEqual(submittedCode, pairing.code)
            ) {
              if (pairing.expiresAt <= now()) rotatePairing();
              response.setHeader("WWW-Authenticate", "Pairing, Bearer");
              sendJson(response, 401, { error: "invalid_app_grant" });
              return;
            }

            // Reserve and rotate before the asynchronous provider launch so one
            // credential can authorize at most one exchange, even under races.
            rotatePairing();
            session = await getOrCreateSession(input, origin);
          } else {
            response.setHeader("WWW-Authenticate", "Bearer");
            sendJson(response, 401, { error: "invalid_app_grant" });
            return;
          }
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
        if (
          !claims ||
          !claimsMatchSession(claims, managed, origin) ||
          (managed.authorizationGrantId !== undefined &&
            !connectorAuth?.isGrantActive(managed.authorizationGrantId))
        ) {
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
      } else if (error instanceof ConnectorAuthError) {
        const capacityError =
          error.code === "authorization_capacity" ||
          error.code === "enrollment_capacity" ||
          error.code === "enrollment_busy";
        if (capacityError) response.setHeader("Retry-After", "1");
        sendJson(response, capacityError ? 429 : 400, { error: error.code });
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
    if (legacyPairingEnabled) {
      options.onPairingCodeGenerated?.(pairing.code, iso(pairing.expiresAt));
    }
  }

  async function getOrCreateSession(
    input: CreateSessionInput,
    origin: string,
    authorizationGrantId?: string,
  ): Promise<ManagedSession> {
    const key = sessionKey(
      origin,
      input.appId,
      input.toolHash,
      authorizationGrantId,
    );
    const pending = pendingSessions.get(key);
    if (pending) return pending;
    const operation = (async () => {
      const existing = sessionsByKey.get(key);
      if (existing) return ensureHealthy(existing);
      const providerSessionId = await runtime.createSession({
        appId: input.appId,
        origin,
        toolHash: input.toolHash,
        approvedToolNames: input.tools.map((tool) => tool.name),
      });
      const created: ManagedSession = {
        id: `acs_${randomUUID()}`,
        appId: input.appId,
        origin,
        toolHash: input.toolHash,
        approvedToolNames: input.tools.map((tool) => tool.name),
        ...(authorizationGrantId ? { authorizationGrantId } : {}),
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
        approvedToolNames: session.approvedToolNames,
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
  if (!isRecord(event) || typeof event["type"] !== "string") return false;
  if (event["type"] === "message") {
    if (!hasOnlyKeys(event, ["type", "data", "tools"])) return false;
    const data = event["data"];
    if (!isRecord(data) || !hasOnlyKeys(data, ["role", "content"]))
      return false;
    const content = data["content"];
    if (
      data["role"] !== "user" ||
      !Array.isArray(content) ||
      content.length !== 1 ||
      !isRecord(content[0]) ||
      !hasOnlyKeys(content[0], ["type", "text"]) ||
      content[0]["type"] !== "input_text" ||
      typeof content[0]["text"] !== "string"
    )
      return false;
    return hashOmnigentToolEnvelope(event["tools"]) === expectedHash;
  }
  if (event["type"] === "function_call_output") {
    if (!hasOnlyKeys(event, ["type", "data"])) return false;
    const data = event["data"];
    return (
      isRecord(data) &&
      hasOnlyKeys(data, ["call_id", "output"]) &&
      typeof data["call_id"] === "string" &&
      data["call_id"].length > 0 &&
      data["call_id"].length <= 256 &&
      typeof data["output"] === "string"
    );
  }
  return (
    event["type"] === "interrupt" &&
    hasOnlyKeys(event, ["type", "data"]) &&
    isRecord(event["data"]) &&
    Object.keys(event["data"]).length === 0
  );
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).every((key) => keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function canonicalPublicEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new TypeError("publicEndpoint must be an HTTPS origin");
  }
  if (endpoint.pathname !== "/" && endpoint.pathname !== "") {
    throw new TypeError("publicEndpoint must not include a path");
  }
  return endpoint.origin;
}

function isDynamicApplicationOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    return (
      origin.protocol === "https:" &&
      origin.origin === value &&
      !origin.username &&
      !origin.password
    );
  } catch {
    return false;
  }
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

function bearerCredential(authorization: string): string | undefined {
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
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

function sessionKey(
  origin: string,
  appId: string,
  toolHash: string,
  authorizationGrantId?: string,
): string {
  return `${origin}\n${appId}\n${toolHash}\n${authorizationGrantId ?? "pairing"}`;
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

async function readJsonObject(
  request: IncomingMessage,
  limit: number,
): Promise<Record<string, unknown>> {
  const raw = await readBody(request, limit);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InvalidRequestError("request body must be JSON");
  }
  if (!isRecord(value))
    throw new InvalidRequestError("request must be an object");
  return value;
}

function requireString(
  value: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const result = value[name];
  if (typeof result !== "string" || result.length === 0) {
    throw new InvalidRequestError(`${name} is required`);
  }
  return result;
}

function requireStringArray(
  value: Readonly<Record<string, unknown>>,
  name: string,
): readonly string[] {
  const result = value[name];
  if (
    !Array.isArray(result) ||
    result.some((item) => typeof item !== "string")
  ) {
    throw new InvalidRequestError(`${name} must be an array of strings`);
  }
  return result as string[];
}

function requireTailscaleUser(
  request: IncomingMessage,
  response: ServerResponse,
  allowed: ReadonlySet<string>,
): string | undefined {
  const tailscaleUser = header(request, "tailscale-user-login");
  if (!tailscaleUser || !allowed.has(tailscaleUser)) {
    sendJson(response, 403, { error: "tailscale_user_not_allowed" });
    return undefined;
  }
  return tailscaleUser;
}

function requireTransportPrincipal(
  request: IncomingMessage,
  response: ServerResponse,
  allowedTailscaleUsers: ReadonlySet<string>,
  publicDemo: boolean,
): string | undefined {
  if (publicDemo) return PUBLIC_DEMO_PRINCIPAL;
  if (!isLoopbackAddress(request.socket.localAddress)) {
    sendJson(response, 403, { error: "trusted_proxy_required" });
    return undefined;
  }
  return requireTailscaleUser(request, response, allowedTailscaleUsers);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function matchesPublicDemoAuthority(
  requested: {
    readonly appId: string;
    readonly redirectUri: string;
    readonly toolHash: string;
  },
  configured: GatewayOptions["publicDemoAuthorities"],
): boolean {
  return Boolean(
    configured?.some(
      (authority) =>
        requested.appId === authority.appId &&
        requested.redirectUri === authority.redirectUri &&
        requested.toolHash === authority.toolHash,
    ),
  );
}

async function handleAuthorizationPage(
  request: IncomingMessage,
  response: ServerResponse,
  auth: ConnectorAuth,
  tailscaleUser: string,
  publicEndpoint: string,
): Promise<void> {
  if (request.method === "GET") {
    const id = new URL(
      request.url ?? "/",
      "http://gateway.invalid",
    ).searchParams.get("request");
    const pending = id ? auth.getPending(id) : undefined;
    if (!pending) {
      sendHtml(
        response,
        404,
        consentErrorPage("Authorization request expired"),
      );
      return;
    }
    const enrolled = auth.isDeviceEnrolled(
      cookie(request, DEVICE_COOKIE),
      tailscaleUser,
    );
    sendHtml(response, 200, consentPage(pending, enrolled), pending.origin);
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  const requestOrigin = header(request, "origin");
  if (requestOrigin !== publicEndpoint) {
    sendJson(response, 403, { error: "authorization_origin_mismatch" });
    return;
  }
  const form = new URLSearchParams(await readBody(request, MAX_CREATE_BYTES));
  const requestId = form.get("request") ?? "";
  const pending = auth.getPending(requestId);
  if (!pending) {
    sendHtml(response, 404, consentErrorPage("Authorization request expired"));
    return;
  }
  if (form.get("decision") !== "approve") {
    const denied = auth.deny(requestId);
    redirect(
      response,
      authorizationRedirect(denied, { error: "access_denied" }),
    );
    return;
  }
  let deviceToken = cookie(request, DEVICE_COOKIE);
  if (!auth.isDeviceEnrolled(deviceToken, tailscaleUser)) {
    const passphrase = form.get("passphrase") ?? "";
    deviceToken = await auth.enrollDevice(passphrase, tailscaleUser, requestId);
    response.setHeader(
      "Set-Cookie",
      `${DEVICE_COOKIE}=${encodeURIComponent(deviceToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
    );
  }
  const approved = auth.approve(requestId);
  redirect(
    response,
    authorizationRedirect(approved.request, { code: approved.code }),
  );
}

async function handleGrantPage(
  request: IncomingMessage,
  response: ServerResponse,
  auth: ConnectorAuth,
  publicEndpoint: string,
): Promise<void> {
  if (request.method === "POST") {
    if (header(request, "origin") !== publicEndpoint) {
      sendJson(response, 403, { error: "authorization_origin_mismatch" });
      return;
    }
    const form = new URLSearchParams(await readBody(request, MAX_CREATE_BYTES));
    const id = form.get("grant") ?? "";
    auth.revokeGrant(id);
    redirect(response, "/v1/grants");
    return;
  }
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET, POST");
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  sendHtml(response, 200, grantsPage(auth.listGrants()));
}

function consentPage(
  request: PendingAuthorization,
  deviceEnrolled: boolean,
): string {
  const tools = request.tools
    .map(
      (tool) =>
        `<li><strong>${escapeHtml(tool.name)}</strong> — ${escapeHtml(tool.description)}<details><summary>Input schema</summary><pre>${escapeHtml(JSON.stringify(tool.inputSchema, null, 2))}</pre></details></li>`,
    )
    .join("");
  const scopes = request.scopes
    .map((scope) => `<li>${escapeHtml(scope)}</li>`)
    .join("");
  return htmlPage(
    "Authorize application",
    `<main><p class="eyebrow">Agent Connect</p><h1>Allow this application?</h1>
<p><strong>${escapeHtml(request.origin)}</strong> is asking to use your agent subscription.</p>
<section class="warning"><h2>Only continue if you trust this application</h2><p>Authorization does not make an application trustworthy. A malicious application could send instructions designed to make your agent expose data available in its environment, misuse your subscription, or use the tools below in harmful ways. Continue only if you recognize and trust <strong>${escapeHtml(request.origin)}</strong>.</p></section>
<dl><dt>Application</dt><dd>${escapeHtml(request.appId)}</dd><dt>Return URL</dt><dd>${escapeHtml(request.redirectUri)}</dd><dt>Request expires</dt><dd>${escapeHtml(iso(request.expiresAt))}</dd><dt>Tools lent to the agent</dt><dd><ul>${tools}</ul></dd><dt>Access</dt><dd><ul>${scopes}</ul></dd></dl>
<form method="post" action="/authorize">
<input type="hidden" name="request" value="${escapeHtml(request.id)}">
${
  deviceEnrolled
    ? '<p class="ok">This browser device is enrolled.</p>'
    : '<label>Enrollment passphrase<input name="passphrase" type="password" autocomplete="current-password" required><small>Enter the passphrase saved when you installed this gateway. It stays on this gateway-owned page.</small></label>'
}
<div class="actions"><button name="decision" value="approve">Allow</button><button class="secondary" name="decision" value="deny" formnovalidate>Deny</button></div>
</form></main>`,
  );
}

function grantsPage(
  grants: readonly {
    id: string;
    origin: string;
    appId: string;
    toolNames: readonly string[];
    expiresAt: string;
    revokedAt?: string;
  }[],
): string {
  const entries = grants
    .map(
      (grant) =>
        `<article><h2>${escapeHtml(grant.appId)}</h2><p>${escapeHtml(grant.origin)}</p><p>Tools: ${escapeHtml(grant.toolNames.join(", ") || "none")}</p><p>${grant.revokedAt ? `Revoked ${escapeHtml(grant.revokedAt)}` : `Expires ${escapeHtml(grant.expiresAt)}`}</p>${grant.revokedAt ? "" : `<form method="post"><input type="hidden" name="grant" value="${escapeHtml(grant.id)}"><button>Revoke</button></form>`}</article>`,
    )
    .join("");
  return htmlPage(
    "Authorized applications",
    `<main><p class="eyebrow">Agent Connect</p><h1>Authorized applications</h1>${entries || "<p>No applications authorized.</p>"}</main>`,
  );
}

function consentErrorPage(message: string): string {
  return htmlPage(
    "Agent Connect",
    `<main><h1>${escapeHtml(message)}</h1></main>`,
  );
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui;background:#f4f1ea;color:#182019;margin:0}main{max-width:38rem;margin:8vh auto;background:white;padding:2rem;border-radius:1rem;box-shadow:0 1rem 4rem #16201620}.eyebrow{color:#42664b;text-transform:uppercase;letter-spacing:.12em;font-weight:700}h1{font-size:2rem}h2{font-size:1.15rem;margin:.1rem 0}.warning{padding:1rem;margin:1.5rem 0;background:#fff1df;border:2px solid #b14f18;border-radius:.6rem;color:#59280d}.warning p{margin:.35rem 0 0}dt{font-weight:700;margin-top:1rem}dd{margin-left:0}label{display:grid;gap:.4rem;margin:1.5rem 0}input{font:inherit;padding:.8rem}small{color:#526057}.actions{display:flex;gap:.75rem;margin-top:1.5rem}button{font:inherit;font-weight:700;padding:.8rem 1.2rem;border:0;border-radius:.6rem;background:#245c35;color:white}.secondary{background:#dce5dd;color:#182019}.ok{padding:.8rem;background:#e4f2e7;border-radius:.5rem}article{border-top:1px solid #ddd;padding:1rem 0}</style></head><body>${body}</body></html>`;
}

function sendHtml(
  response: ServerResponse,
  status: number,
  html: string,
  applicationRedirectOrigin?: string,
): void {
  const formAction = applicationRedirectOrigin
    ? `'self' ${cspOrigin(applicationRedirectOrigin)}`
    : "'self'";
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
  );
  // Chromium serializes the Origin of a same-origin form POST as `null` when
  // the document uses `no-referrer`, which makes the strict consent/revocation
  // Origin check reject the connector's own form. `same-origin` preserves the
  // connector Origin for local POSTs while still withholding the referrer on
  // the cross-origin OAuth redirect back to the application.
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(html);
}

function cspOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError("Invalid application redirect Origin for CSP");
  }
  return parsed.origin;
}

function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 303;
  response.setHeader("Location", location);
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

function cookie(request: IncomingMessage, name: string): string | undefined {
  const raw = header(request, "cookie");
  if (!raw) return undefined;
  for (const item of raw.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
