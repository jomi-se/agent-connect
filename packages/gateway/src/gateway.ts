import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";

import {
  issueCapability,
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
import { OmnigentResponseBackend } from "./omnigent-response-backend.js";
import { OmnigentRuntime } from "./omnigent-runtime.js";
import { handleResponseRoute, matchResponseRoute } from "./response-routes.js";
import type { ResponseBackend } from "./responses/backend.js";
import { ResponseEngine } from "./responses/engine.js";
import { FileResponseStore } from "./responses/file-store.js";
import type { ChainRecord, ResponseStore } from "./responses/store.js";
import type { OmnigentSandboxOptions } from "./omnigent-runtime.js";
import type { AgentRuntime, RuntimeSessionUsage } from "./runtime.js";
import type {
  EngineSession,
  SessionEndReason,
  SessionLifecycle,
} from "./responses/engine.js";
import {
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
  readonly capabilityTtlSeconds?: number;
  /** No request and no live chain for this long retires the session. */
  readonly sessionIdleTimeoutSeconds?: number;
  /** How long a published function call may stay unanswered by the application. */
  readonly parkedCallTimeoutSeconds?: number;
  /** Safety cap on a running turn that stops producing backend events. */
  readonly runningTurnTimeoutSeconds?: number;
  readonly authStatePath: string;
  readonly publicEndpoint: string;
  readonly transportProfile?: string;
  /** Internal deterministic-test seam; production startup never reads this from configuration. */
  readonly enrollmentPassphrase?: string;
  readonly runtime?: AgentRuntime;
  readonly responseBackend?: ResponseBackend;
  readonly responseStore?: ResponseStore;
  readonly responseStatePath?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly onEnrollmentBundle?: (bundle: EnrollmentBundle) => void;
}

interface ManagedSession {
  readonly id: string;
  readonly appId: string;
  readonly origin: string;
  readonly toolHash: string;
  readonly approvedToolNames: readonly string[];
  readonly tools: readonly GatewayToolDefinition[];
  readonly authorizationGrantId: string;
  providerSessionId: string;
  /** When the signed capability stops verifying; refreshed by the client. */
  expiresAt: number;
  /**
   * When this session last did anything. Session lifetime slides on activity
   * rather than running from issuance, so an abandoned tab is released in
   * minutes while a session in continuous use is never reaped underneath it.
   */
  lastActivityAt: number;
  readonly createdAt: number;
  readonly provisionedInProcess: boolean;
}

interface ConsoleSession {
  readonly id: string;
  readonly appId: string;
  readonly origin: string;
  readonly state: SessionLifecycle["kind"];
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly capabilityExpiresAt: number;
  readonly retiresInSeconds: number;
  readonly turns: number;
  readonly usage: RuntimeSessionUsage | undefined;
}

interface ConsoleEndedSession {
  readonly id: string;
  readonly appId: string;
  readonly origin: string;
  readonly turns: number;
  readonly endedAt: number;
  readonly outcome: string;
  /** Absent for a session this process did not itself retire. */
  readonly usage: RuntimeSessionUsage | undefined;
}

interface ConsoleView {
  readonly live: readonly ConsoleSession[];
  readonly ended: readonly ConsoleEndedSession[];
  readonly capacity: number;
  readonly idleTimeoutSeconds: number;
  readonly parkedTimeoutSeconds: number;
  readonly runningTimeoutSeconds: number;
  readonly generatedAt: number;
}

const MAX_CREATE_BYTES = 64 * 1024;
const MAX_SESSIONS_PER_GRANT_APP = 8;
const DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_PARKED_CALL_TIMEOUT_SECONDS = 3 * 60;
const DEFAULT_RUNNING_TURN_TIMEOUT_SECONDS = 30 * 60;
const CONSOLE_RECENT_SESSIONS = 20;
const DEVICE_COOKIE = "agent_connect_device";

export function createGateway(options: GatewayOptions) {
  const dynamicAppEnrollment = options.dynamicAppEnrollment === true;
  if (options.allowedOrigins.size === 0 && !dynamicAppEnrollment) {
    throw new TypeError("At least one allowed browser origin is required");
  }
  if (dynamicAppEnrollment && options.transportProfile !== "tailscale-serve") {
    throw new TypeError(
      "dynamic app enrollment requires the tailscale-serve transport profile",
    );
  }
  if (options.allowedTailscaleUsers.size === 0) {
    throw new TypeError("At least one allowed Tailscale login is required");
  }
  const publicEndpoint = canonicalPublicEndpoint(options.publicEndpoint);

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
  const connectorAuth = new ConnectorAuth({
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
  });
  const capabilityTtl = options.capabilityTtlSeconds ?? 60 * 60;
  const sessionIdleTimeout =
    options.sessionIdleTimeoutSeconds ?? DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS;
  const parkedCallTimeout =
    options.parkedCallTimeoutSeconds ?? DEFAULT_PARKED_CALL_TIMEOUT_SECONDS;
  const runningTurnTimeout =
    options.runningTurnTimeoutSeconds ?? DEFAULT_RUNNING_TURN_TIMEOUT_SECONDS;
  const signingSecret = connectorAuth.capabilitySigningSecret;
  const managedSessions = new Map<string, ManagedSession>();
  /** In-flight creations per grant/app/tool key, for the capacity check. */
  const pendingCreations = new Map<string, number>();
  const pendingRepairs = new Map<string, Promise<ManagedSession>>();
  /**
   * Final usage of sessions this process retired. Teardown deletes the provider
   * session, and its cost record goes with it, so the last reading has to be
   * taken before that. Process-local by design: the durable ledger is the
   * response store, which does not carry usage, so a restart loses these rather
   * than reporting them wrongly.
   */
  const finalUsage = new Map<string, RuntimeSessionUsage>();
  const responseStore =
    options.responseStore ??
    new FileResponseStore(
      options.responseStatePath ??
        join(dirname(options.authStatePath), "responses"),
    );
  const responseEngine = new ResponseEngine({
    store: responseStore,
    backend:
      options.responseBackend ??
      new OmnigentResponseBackend({
        baseUrl: omnigentBaseUrl,
        fetch: fetchImplementation,
      }),
    isGrantActive: (grantId) => connectorAuth.isGrantActive(grantId),
    now,
  });
  /**
   * Rebuilds the application sessions that live response chains belong to, from
   * the durable chain records alone. Without this a restarted gateway answers a
   * capability for an existing chain with a bare 401, hiding the fact that the
   * chain is recoverable, complete, or terminally interrupted rather than
   * unknown.
   *
   * A rehydrated session is reachable only through the signed capability that
   * names it, which remains the authorization oracle after restart. Nothing
   * reconstructs a way for a bare application grant to find one.
   */
  const responseSessionsReady = (async () => {
    const chains = [...(await responseStore.listChains())].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
    for (const chain of chains) {
      if (await responseStore.isSessionRetired(chain.appSessionId)) continue;
      // Terminal chains are rehydrated too: a response that completed during an
      // outage must stay retrievable, and that is the reason the chain resource
      // exists at all. When one application session has several chains, the
      // most recently updated one supplies the provider session.
      if (managedSessions.has(chain.appSessionId)) continue;
      const session: ManagedSession = {
        id: chain.appSessionId,
        appId: chain.appId,
        origin: chain.origin,
        toolHash: chain.toolHash,
        approvedToolNames: chain.tools.map((tool) => tool.name),
        tools: chain.tools,
        authorizationGrantId: chain.authorizationGrantId,
        providerSessionId: chain.providerSessionId,
        // The signed capability is the authorization oracle after restart.
        // Its latest issue time is deliberately not reconstructed from a chain
        // timestamp, which could predate a later capability refresh.
        expiresAt: Math.floor(now() / 1000) + capabilityTtl,
        // A rehydrated session starts its idle clock now. A chain timestamp is
        // the wrong origin: it would reap the session the instant the gateway
        // returned from an outage longer than the idle timeout, before its
        // application had any chance to reconnect.
        lastActivityAt: Math.floor(now() / 1000),
        createdAt: chain.createdAt,
        provisionedInProcess: false,
      };
      managedSessions.set(chain.appSessionId, session);
    }
  })();

  /**
   * Which clock, if any, has run out for a session.
   *
   * Session lifetime is a declared policy rather than an attempt to detect
   * whether the application is still there. A parked call and an abandoned tab
   * are byte-identical in every durable and in-memory record — the segment
   * ended and the gateway holds no socket to the browser — so nothing can tell
   * them apart. What the gateway can do is say how long each state is allowed
   * to last, and the three states need genuinely different answers: a running
   * turn may be silent for as long as the agent thinks, a parked call must be
   * answered promptly because the application is supposed to be executing it
   * right now, and an idle session is just waiting to be reused.
   */
  const expiryReason = async (
    session: ManagedSession,
  ): Promise<SessionEndReason | undefined> => {
    const timestamp = Math.floor(now() / 1000);
    const lifecycle = await responseEngine.sessionLifecycle(session.id);
    if (lifecycle.kind === "running") {
      return timestamp - lifecycle.since >= runningTurnTimeout
        ? "stalled"
        : undefined;
    }
    if (lifecycle.kind === "parked") {
      return timestamp - lifecycle.since >= parkedCallTimeout
        ? "unanswered_call"
        : undefined;
    }
    return timestamp - session.lastActivityAt >= sessionIdleTimeout
      ? "idle"
      : undefined;
  };

  /**
   * Retires one session and everything provisioned for it. Shared by the
   * reaper and by explicit termination from the console, so both paths release
   * the provider session rather than only the gateway's own record.
   */
  const releaseSession = async (
    session: ManagedSession,
    reason: SessionEndReason,
  ): Promise<void> => {
    // Persist retirement before removing in-memory authority. Otherwise a
    // restart could reconstruct the expired opaque session from its chains.
    await responseStore.retireSession(session.id);
    managedSessions.delete(session.id);
    await responseEngine.expireSession(session.id, reason);
    // The last usage reading has to be taken before teardown removes it.
    const usage = await sessionUsage(session.providerSessionId);
    if (usage) {
      if (finalUsage.size >= CONSOLE_RECENT_SESSIONS * 2) {
        const oldest = finalUsage.keys().next();
        if (!oldest.done) finalUsage.delete(oldest.value);
      }
      finalUsage.set(session.id, usage);
    }
    // Teardown last and best-effort: the session is already unusable, and a
    // provider that cannot be reached must not leave it standing.
    await destroyProviderSession(session.providerSessionId);
  };

  const destroyProviderSession = async (
    providerSessionId: string,
  ): Promise<void> => {
    try {
      await runtime.destroySession?.(providerSessionId);
    } catch {
      // A leaked provider session is worse than a silent failure here, but the
      // gateway has no channel to report it on yet; the console shows the
      // session as ended either way.
    }
  };

  // Deciding expiry now costs a lifecycle read per session, and every request
  // sweeps before it is routed. Expiry has never needed to be instant, so the
  // sweep is throttled to a fraction of the shortest clock instead of running
  // on the hot path.
  const sweepIntervalSeconds = Math.max(
    1,
    Math.floor(
      Math.min(sessionIdleTimeout, parkedCallTimeout, runningTurnTimeout) / 10,
    ),
  );
  let lastSweepAt = Number.NEGATIVE_INFINITY;
  let reaping: Promise<void> | undefined;
  const reapExpiredSessions = (): Promise<void> => {
    if (reaping) return reaping;
    const timestamp = Math.floor(now() / 1000);
    if (timestamp - lastSweepAt < sweepIntervalSeconds)
      return Promise.resolve();
    lastSweepAt = timestamp;
    reaping = (async () => {
      await responseSessionsReady;
      for (const session of [...managedSessions.values()]) {
        // Per session: one unreachable provider must not strand every later
        // session in the sweep, which is what an uncaught throw here would do.
        try {
          const reason = await expiryReason(session);
          if (!reason) continue;
          await releaseSession(session, reason);
        } catch {
          continue;
        }
      }
    })().finally(() => {
      reaping = undefined;
    });
    return reaping;
  };

  const server = createServer(async (request, response) => {
    try {
      await reapExpiredSessions();
      if (request.url === "/healthz" && request.method === "GET") {
        sendJson(response, 200, { ok: true });
        return;
      }

      const pathname = new URL(request.url ?? "/", "http://gateway.invalid")
        .pathname;

      if (
        pathname === "/authorize" ||
        pathname === "/v1/grants" ||
        pathname === "/sessions"
      ) {
        const principal = requireTransportPrincipal(
          request,
          response,
          options.allowedTailscaleUsers,
        );
        if (!principal) return;
        if (pathname === "/sessions") {
          await handleSessionConsole(request, response);
          return;
        }
        if (pathname === "/authorize") {
          await handleAuthorizationPage(
            request,
            response,
            connectorAuth,
            principal,
            publicEndpoint,
          );
        } else {
          await handleGrantPage(
            request,
            response,
            connectorAuth,
            publicEndpoint,
          );
        }
        return;
      }

      const origin = header(request, "origin");
      const responseRoute = matchResponseRoute(pathname);
      // Two ingress profiles, decided in ADR 0009. A browser always attaches an
      // ambient Origin and stays bound to it, so the absence of one reliably
      // selects a non-browser caller. That profile is admitted only on the
      // response routes, only with a transport principal, and only when the
      // grant carries the explicit non-browser consent bit. Dynamic enrollment
      // is closed to it.
      if (origin === undefined && responseRoute && !dynamicAppEnrollment) {
        const principal = requireTransportPrincipal(
          request,
          response,
          options.allowedTailscaleUsers,
        );
        if (!principal) return;
        await responseSessionsReady;
        const session = authorizeResponseSession(request, response, undefined);
        if (!session) return;
        try {
          await handleResponseRoute(
            responseRoute,
            request,
            response,
            responseEngine,
            session,
          );
        } finally {
          touchSession(session.sessionId);
        }
        return;
      }
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
        await responseSessionsReady;
        const input = await readCreateRequest(request);
        const authorization = header(request, "authorization") ?? "";
        const existingClaims = bearerClaims(
          authorization,
          signingSecret,
          Math.floor(now() / 1000),
        );
        let session: ManagedSession;

        if (existingClaims) {
          if (input.fresh) {
            throw new InvalidRequestError(
              "fresh sessions require the application grant, not a session capability",
            );
          }
          session = requireExistingSession(
            existingClaims,
            input,
            origin,
            managedSessions,
          );
          if (!connectorAuth.isGrantActive(session.authorizationGrantId)) {
            sendJson(response, 401, { error: "grant_revoked" });
            return;
          }
          // Refreshing the capability of a session that still has a live
          // response chain must not repair the provider session underneath it:
          // the chain's private call IDs belong to the old one. The chain
          // reports its own recovery outcome through the control extensions.
          session =
            (await responseEngine.runIfSessionIdle(session.id, () =>
              ensureHealthy(session),
            )) ?? session;
        } else {
          const bearer = bearerCredential(authorization);
          const grant = bearer
            ? connectorAuth.verifyGrant(bearer, {
                origin,
                appId: input.appId,
                toolHash: input.toolHash,
                scopes: ["agent:prompt", "agent:result", "tools:invoke"],
              })
            : undefined;
          if (grant) {
            session = await createManagedSession(input, origin, grant.id);
          } else {
            response.setHeader("WWW-Authenticate", "Bearer");
            sendJson(response, 401, { error: "invalid_app_grant" });
            return;
          }
        }

        const issuedAt = Math.floor(now() / 1000);
        const expiresAt = issuedAt + capabilityTtl;
        session.expiresAt = expiresAt;
        session.lastActivityAt = issuedAt;
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

      if (responseRoute) {
        await responseSessionsReady;
        const session = authorizeResponseSession(request, response, origin);
        if (!session) return;
        try {
          await handleResponseRoute(
            responseRoute,
            request,
            response,
            responseEngine,
            session,
          );
        } finally {
          // A turn that ran for twenty minutes must not leave behind a
          // twenty-minute-old idle clock; the session was busy the whole time.
          touchSession(session.sessionId);
        }
        return;
      }

      sendJson(response, 404, { error: "route_not_found" });
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
      } else if (error instanceof SessionCapacityError) {
        // Retryable, not a malformed request: the slots free themselves as
        // sessions go idle, and the owner can free one immediately.
        response.setHeader("Retry-After", "30");
        sendJson(response, 429, {
          error: "session_capacity",
          message: error.message,
          manageUrl: `${publicEndpoint}/sessions`,
        });
      } else if (error instanceof SessionExpiredError) {
        response.setHeader("WWW-Authenticate", "Bearer");
        sendJson(response, 401, { error: "session_expired" });
      } else if (error instanceof InvalidCapabilityError) {
        sendJson(response, 401, { error: "invalid_session_capability" });
      } else {
        sendJson(response, 502, { error: "upstream_unavailable" });
      }
    }
  });
  const reapInterval = setInterval(
    () => void reapExpiredSessions().catch(() => {}),
    Math.max(
      1_000,
      Math.min(
        60_000,
        Math.min(sessionIdleTimeout, parkedCallTimeout, runningTurnTimeout) *
          1000,
      ),
    ),
  );
  reapInterval.unref();
  server.on("close", () => clearInterval(reapInterval));
  return server;

  /**
   * Resolves the application session behind a response request. `origin` is
   * undefined for the standard-client profile, which is bound to the
   * capability's own signed origin claim instead of an ambient one, and which
   * additionally requires the grant's non-browser consent bit.
   *
   * Deliberately does not call `ensureHealthy`: transparent provider-session
   * replacement is invalid for an active response chain, whose private call IDs
   * belong to the old provider session.
   */
  function authorizeResponseSession(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string | undefined,
  ): EngineSession | undefined {
    const claims = bearerClaims(
      header(request, "authorization") ?? "",
      signingSecret,
      Math.floor(now() / 1000),
    );
    const managed = claims ? managedSessions.get(claims.sessionId) : undefined;
    if (claims && !managed) {
      response.setHeader("WWW-Authenticate", "Bearer");
      sendJson(response, 401, { error: "session_expired" });
      return undefined;
    }
    if (
      !claims ||
      !managed ||
      !claimsMatchSession(claims, managed, origin) ||
      !connectorAuth.isGrantActive(managed.authorizationGrantId) ||
      (origin === undefined &&
        !connectorAuth.grantAllowsNonBrowserClients(
          managed.authorizationGrantId,
        ))
    ) {
      response.setHeader("WWW-Authenticate", "Bearer");
      sendJson(response, 401, { error: "invalid_session_capability" });
      return undefined;
    }
    managed.lastActivityAt = Math.floor(now() / 1000);
    return {
      sessionId: managed.id,
      appId: managed.appId,
      origin: managed.origin,
      toolHash: managed.toolHash,
      tools: managed.tools,
      authorizationGrantId: managed.authorizationGrantId,
      providerSessionId: managed.providerSessionId,
    };
  }

  function touchSession(sessionId: string): void {
    const session = managedSessions.get(sessionId);
    if (session) session.lastActivityAt = Math.floor(now() / 1000);
  }

  /**
   * The owner's view of what the gateway is doing, and the one control it
   * offers: ending a session. It exists because the deployment tiers this
   * project is heading for include users who cannot read a terminal, and
   * because an application that is refused a session needs somewhere to send
   * them.
   */
  async function handleSessionConsole(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method === "POST") {
      if (header(request, "origin") !== publicEndpoint) {
        sendJson(response, 403, { error: "authorization_origin_mismatch" });
        return;
      }
      const form = new URLSearchParams(
        await readBody(request, MAX_CREATE_BYTES),
      );
      const session = managedSessions.get(form.get("session") ?? "");
      if (session) await releaseSession(session, "ended_by_owner");
      redirect(response, "/sessions");
      return;
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET, POST");
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    await responseSessionsReady;
    sendHtml(response, 200, sessionsPage(await describeSessions()));
  }

  /**
   * Joins the live session table with the durable chain ledger. Sessions the
   * gateway no longer holds are reported from their chains alone, which is why
   * recent history survives both expiry and a restart.
   */
  async function describeSessions(): Promise<ConsoleView> {
    const timestamp = Math.floor(now() / 1000);
    const chainsBySession = new Map<string, ChainRecord[]>();
    for (const chain of await responseStore.listChains()) {
      const existing = chainsBySession.get(chain.appSessionId);
      if (existing) existing.push(chain);
      else chainsBySession.set(chain.appSessionId, [chain]);
    }
    // Usage is one provider round trip per session, so the page fans them out
    // rather than paying for them in series.
    const usageBySession = new Map(
      await Promise.all(
        [...managedSessions.values()].map(
          async (session) =>
            [
              session.id,
              await sessionUsage(session.providerSessionId),
            ] as const,
        ),
      ),
    );
    const live: ConsoleSession[] = [];
    for (const session of managedSessions.values()) {
      const chains = chainsBySession.get(session.id) ?? [];
      const lifecycle = await responseEngine.sessionLifecycle(session.id);
      live.push({
        id: session.id,
        appId: session.appId,
        origin: session.origin,
        state: lifecycle.kind,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        capabilityExpiresAt: session.expiresAt,
        retiresInSeconds: retiresInSeconds(session, lifecycle, timestamp),
        turns: chains.length,
        usage: usageBySession.get(session.id),
      });
    }
    const ended: ConsoleEndedSession[] = [...chainsBySession.entries()]
      .filter(([sessionId]) => !managedSessions.has(sessionId))
      .map(([sessionId, chains]) => ({
        id: sessionId,
        appId: chains[0]?.appId ?? "unknown",
        origin: chains[0]?.origin ?? "unknown",
        turns: chains.length,
        usage: finalUsage.get(sessionId),
        endedAt: chains.reduce(
          (latest, chain) => Math.max(latest, chain.updatedAt),
          0,
        ),
        outcome:
          chains
            .slice()
            .sort((left, right) => right.updatedAt - left.updatedAt)[0]
            ?.terminalError?.message ?? "completed",
      }))
      .sort((left, right) => right.endedAt - left.endedAt)
      .slice(0, CONSOLE_RECENT_SESSIONS);
    return {
      live: live.sort(
        (left, right) => right.lastActivityAt - left.lastActivityAt,
      ),
      ended,
      capacity: MAX_SESSIONS_PER_GRANT_APP,
      idleTimeoutSeconds: sessionIdleTimeout,
      parkedTimeoutSeconds: parkedCallTimeout,
      runningTimeoutSeconds: runningTurnTimeout,
      generatedAt: timestamp,
    };
  }

  async function sessionUsage(
    providerSessionId: string,
  ): Promise<RuntimeSessionUsage | undefined> {
    try {
      return await runtime.describeSession?.(providerSessionId);
    } catch {
      return undefined;
    }
  }

  function retiresInSeconds(
    session: ManagedSession,
    lifecycle: SessionLifecycle,
    timestamp: number,
  ): number {
    if (lifecycle.kind === "running") {
      return lifecycle.since + runningTurnTimeout - timestamp;
    }
    if (lifecycle.kind === "parked") {
      return lifecycle.since + parkedCallTimeout - timestamp;
    }
    return session.lastActivityAt + sessionIdleTimeout - timestamp;
  }

  /**
   * Provisions a new application session for an application grant.
   *
   * Presenting the grant means "create", always. There is deliberately no path
   * by which a grant selects an existing session: the only key such a lookup
   * could use is the grant, application, and tool snapshot, which every tab of
   * the same application shares. Adopting the newest match under that key is
   * ambient global state the caller neither names nor owns, and with parallel
   * sessions it would silently hand one tab another tab's conversation. An
   * extra session is a bounded cost; a crossed conversation is not.
   *
   * Reconnecting to a specific session is the session capability's job, and
   * only the capability's: it names the one session it is for.
   */
  async function createManagedSession(
    input: CreateSessionInput,
    origin: string,
    authorizationGrantId: string,
  ): Promise<ManagedSession> {
    const key = sessionKey(
      origin,
      input.appId,
      input.toolHash,
      authorizationGrantId,
    );
    const live = [...managedSessions.values()].filter(
      (session) =>
        session.provisionedInProcess &&
        sessionKey(
          session.origin,
          session.appId,
          session.toolHash,
          session.authorizationGrantId,
        ) === key,
    ).length;
    // Concurrent creates are no longer coalesced, so the capacity check has to
    // count the ones still awaiting the provider as well. Reserving before the
    // await and releasing in `finally` is race-free without a lock: nothing
    // else runs between the count and the reservation.
    const reserved = pendingCreations.get(key) ?? 0;
    if (live + reserved >= MAX_SESSIONS_PER_GRANT_APP) {
      throw new SessionCapacityError(
        `at most ${MAX_SESSIONS_PER_GRANT_APP} live sessions may exist for one grant, application, and tool snapshot`,
      );
    }
    pendingCreations.set(key, reserved + 1);
    try {
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
        tools: input.tools,
        authorizationGrantId,
        providerSessionId,
        expiresAt: Math.floor(now() / 1000) + capabilityTtl,
        lastActivityAt: Math.floor(now() / 1000),
        createdAt: Math.floor(now() / 1000),
        provisionedInProcess: true,
      };
      managedSessions.set(created.id, created);
      return created;
    } finally {
      const outstanding = (pendingCreations.get(key) ?? 1) - 1;
      if (outstanding > 0) pendingCreations.set(key, outstanding);
      else pendingCreations.delete(key);
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
      const replaced = session.providerSessionId;
      session.providerSessionId = await runtime.createSession({
        appId: session.appId,
        origin: session.origin,
        toolHash: session.toolHash,
        approvedToolNames: session.approvedToolNames,
      });
      // The unhealthy provider session is unreachable, not absent: its runner
      // process and session workspace outlive the replacement unless released.
      await destroyProviderSession(replaced);
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
  /**
   * @deprecated Presenting the application grant already means "create a new
   * session", so this flag no longer selects between two behaviours. It is
   * still accepted and still rejected alongside a session capability, so
   * existing clients that send it keep working unchanged.
   */
  readonly fresh: boolean;
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
  const fresh = value["fresh"] ?? false;
  if (typeof fresh !== "boolean") {
    throw new InvalidRequestError("fresh must be a boolean");
  }
  return { appId, tools, toolHash: hashToolSnapshot(tools), fresh };
}

function requireExistingSession(
  claims: CapabilityClaims,
  input: CreateSessionInput,
  origin: string,
  sessions: ReadonlyMap<string, ManagedSession>,
): ManagedSession {
  const session = sessions.get(claims.sessionId);
  if (!session) throw new SessionExpiredError();
  if (
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
  origin: string | undefined,
): boolean {
  return (
    // The standard-client profile has no ambient origin to compare against, so
    // it relies on the capability's signed origin claim alone.
    (origin === undefined || claims.origin === origin) &&
    claims.origin === session.origin &&
    claims.appId === session.appId &&
    claims.sessionId === session.id &&
    claims.toolHash === session.toolHash
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
  authorizationGrantId: string,
): string {
  return `${origin}\n${appId}\n${toolHash}\n${authorizationGrantId}`;
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
/**
 * The capability verified but names a session the gateway no longer holds. It
 * is deliberately distinct from an invalid capability: the client's correct
 * response is to start a new session, not to refresh a token that is already
 * valid, and without the distinction it would retry-loop against a dead
 * session. Disclosing it leaks nothing — a signed capability is proof the
 * holder owned the session it names.
 */
class SessionExpiredError extends Error {}
/** Too many live sessions for one grant, application, and tool snapshot. */
class SessionCapacityError extends Error {}

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
): string | undefined {
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
  const approved = auth.approve(requestId, {
    nonBrowserClients: form.get("non_browser_clients") === "yes",
  });
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
<label class="choice"><input type="checkbox" name="non_browser_clients" value="yes"><span>Also allow non-browser clients (scripts, servers, CLI tools) to use this authorization.<small>Leave this off unless you need it. With it off, only the browser application at ${escapeHtml(request.origin)} can use this authorization; a caller that presents no browser origin is refused.</small></span></label>
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
    nonBrowserClients: boolean;
    revokedAt?: string;
  }[],
): string {
  const entries = grants
    .map(
      (grant) =>
        `<article><h2>${escapeHtml(grant.appId)}</h2><p>${escapeHtml(grant.origin)}</p><p>Tools: ${escapeHtml(grant.toolNames.join(", ") || "none")}</p><p>Non-browser clients: ${grant.nonBrowserClients ? "allowed" : "not allowed"}</p><p>${grant.revokedAt ? `Revoked ${escapeHtml(grant.revokedAt)}` : `Expires ${escapeHtml(grant.expiresAt)}`}</p>${grant.revokedAt ? "" : `<form method="post"><input type="hidden" name="grant" value="${escapeHtml(grant.id)}"><button>Revoke</button></form>`}</article>`,
    )
    .join("");
  return htmlPage(
    "Authorized applications",
    `<main><p class="eyebrow">Agent Connect</p><h1>Authorized applications</h1><p><a href="/sessions">See what is running now</a></p>${entries || "<p>No applications authorized.</p>"}</main>`,
  );
}

const STATE_LABEL: Readonly<Record<SessionLifecycle["kind"], string>> = {
  running: "Working",
  parked: "Waiting for the application",
  idle: "Idle",
};

function sessionsPage(view: ConsoleView): string {
  const rows = view.live
    .map((session) => {
      const cost = costOf(session.usage);
      const tokens = tokensOf(session.usage);
      return `<tr><td><span class="state state-${escapeHtml(session.state)}">${escapeHtml(STATE_LABEL[session.state])}</span></td>
<td><strong>${escapeHtml(session.appId)}</strong><br><small>${escapeHtml(session.origin)}</small><br><small class="mono">${escapeHtml(session.id)}</small></td>
<td>${session.turns}</td><td>${tokens}</td><td>${escapeHtml(cost)}</td>
<td>${escapeHtml(duration(view.generatedAt - session.lastActivityAt))} ago</td>
<td>${escapeHtml(session.retiresInSeconds <= 0 ? "any moment" : duration(session.retiresInSeconds))}</td>
<td><form method="post"><input type="hidden" name="session" value="${escapeHtml(session.id)}"><button class="danger">End</button></form></td></tr>`;
    })
    .join("");
  const past = view.ended
    .map(
      (session) =>
        `<tr><td><strong>${escapeHtml(session.appId)}</strong><br><small>${escapeHtml(session.origin)}</small></td><td>${session.turns}</td><td>${escapeHtml(tokensOf(session.usage))}</td><td>${escapeHtml(costOf(session.usage))}</td><td>${escapeHtml(session.outcome)}</td><td>${escapeHtml(iso(session.endedAt * 1000))}</td></tr>`,
    )
    .join("");
  return htmlPage(
    "Agent sessions",
    `<main class="wide"><p class="eyebrow">Agent Connect</p><h1>Agent sessions</h1>
<p>${view.live.length} live ${view.live.length === 1 ? "session" : "sessions"}. Each application may hold up to ${view.capacity} at once; ending one frees a slot immediately.</p>
<section class="policy"><h2>When sessions end by themselves</h2><ul>
<li><strong>Idle</strong> — after ${escapeHtml(duration(view.idleTimeoutSeconds))} with no request and no work in progress.</li>
<li><strong>Waiting for the application</strong> — after ${escapeHtml(duration(view.parkedTimeoutSeconds))} without an answer to a tool call.</li>
<li><strong>Working</strong> — after ${escapeHtml(duration(view.runningTimeoutSeconds))} with no progress from the agent.</li>
</ul><p>Ending a session does not revoke the application's authorization. Revoke that under <a href="/v1/grants">authorized applications</a>.</p></section>
${
  view.live.length === 0
    ? '<p class="empty">No sessions are running right now.</p>'
    : `<div class="scroll"><table><thead><tr><th>State</th><th>Application</th><th>Turns</th><th>Tokens</th><th>Cost</th><th>Last activity</th><th>Ends in</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
}
<h2>Recent sessions</h2>
${
  past.length === 0
    ? '<p class="empty">No sessions have ended yet.</p>'
    : `<div class="scroll"><table><thead><tr><th>Application</th><th>Turns</th><th>Tokens</th><th>Cost</th><th>Outcome</th><th>Ended</th></tr></thead><tbody>${past}</tbody></table></div>
<p class="empty">Usage is recorded when a session ends and is kept only until this gateway restarts; the provider deletes its own record with the session.</p>`
}
</main>`,
  );
}

function costOf(usage: RuntimeSessionUsage | undefined): string {
  return usage?.totalCostUsd === null || usage?.totalCostUsd === undefined
    ? "—"
    : `$${usage.totalCostUsd.toFixed(4)}`;
}

function tokensOf(usage: RuntimeSessionUsage | undefined): string {
  return usage?.totalTokens === null || usage?.totalTokens === undefined
    ? "—"
    : usage.totalTokens.toLocaleString("en-US");
}

/** Coarse, human-readable, and deliberately never more precise than it is honest. */
function duration(seconds: number): string {
  const value = Math.max(0, Math.round(seconds));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.round(value / 60)} min`;
  const hours = value / 3600;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`;
}

function consentErrorPage(message: string): string {
  return htmlPage(
    "Agent Connect",
    `<main><h1>${escapeHtml(message)}</h1></main>`,
  );
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui;background:#f4f1ea;color:#182019;margin:0}main{max-width:38rem;margin:8vh auto;background:white;padding:2rem;border-radius:1rem;box-shadow:0 1rem 4rem #16201620}main.wide{max-width:66rem}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:.92rem}th{text-align:left;font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:#526057;border-bottom:2px solid #dce5dd;padding:.5rem .6rem}td{padding:.7rem .6rem;border-bottom:1px solid #eceee9;vertical-align:top}.mono{font-family:ui-monospace,monospace;color:#8a938c}.state{display:inline-block;padding:.2rem .55rem;border-radius:999px;font-size:.74rem;font-weight:700;white-space:nowrap}.state-running{background:#e4f2e7;color:#1c4c2b}.state-parked{background:#fff1df;color:#7a3d10}.state-idle{background:#eceee9;color:#526057}.policy{background:#f7f6f1;border-radius:.6rem;padding:1rem 1.2rem;margin:1.5rem 0}.policy h2{font-size:.95rem}.policy ul{margin:.5rem 0 .5rem 1.1rem;padding:0}.policy li{margin:.2rem 0}button.danger{background:#8c2f16;padding:.45rem .85rem;font-size:.85rem}.empty{color:#526057;padding:1rem 0}td form{margin:0}.eyebrow{color:#42664b;text-transform:uppercase;letter-spacing:.12em;font-weight:700}h1{font-size:2rem}h2{font-size:1.15rem;margin:.1rem 0}.warning{padding:1rem;margin:1.5rem 0;background:#fff1df;border:2px solid #b14f18;border-radius:.6rem;color:#59280d}.warning p{margin:.35rem 0 0}dt{font-weight:700;margin-top:1rem}dd{margin-left:0}label{display:grid;gap:.4rem;margin:1.5rem 0}input{font:inherit;padding:.8rem}small{color:#526057}.actions{display:flex;gap:.75rem;margin-top:1.5rem}button{font:inherit;font-weight:700;padding:.8rem 1.2rem;border:0;border-radius:.6rem;background:#245c35;color:white}.secondary{background:#dce5dd;color:#182019}.ok{padding:.8rem;background:#e4f2e7;border-radius:.5rem}.choice{grid-template-columns:auto 1fr;align-items:start;margin:1.25rem 0}.choice small{display:block;margin-top:.25rem}article{border-top:1px solid #ddd;padding:1rem 0}</style></head><body>${body}</body></html>`;
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
