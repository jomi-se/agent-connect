import type { ApplicationTool, JsonObject } from "./types.js";
import { createToolValidator } from "./tool-schema.js";

const AUTHORIZATION_PATH = "/agent-connect/oauth/authorize";
const TOKEN_PATH = "/agent-connect/oauth/token";
const REVOCATION_PATH = "/agent-connect/oauth/revoke";
const PAR_PATH = "/agent-connect/oauth/par";
interface ProviderEndpointLayout {
  readonly issuerPath: "" | "/agent-connect";
  readonly authorizationServerMetadataPath: string;
  readonly protectedResourceMetadataPath: string;
  readonly resourcePath: "/v1/responses" | "/agent-connect/v1/responses";
}

const STANDALONE_LAYOUT: ProviderEndpointLayout = Object.freeze({
  issuerPath: "",
  authorizationServerMetadataPath: "/.well-known/oauth-authorization-server",
  protectedResourceMetadataPath: "/.well-known/oauth-protected-resource",
  resourcePath: "/v1/responses",
});
const STOCK_PLUGIN_LAYOUT: ProviderEndpointLayout = Object.freeze({
  issuerPath: "/agent-connect",
  authorizationServerMetadataPath:
    "/.well-known/oauth-authorization-server/agent-connect",
  protectedResourceMetadataPath:
    "/.well-known/oauth-protected-resource/agent-connect/v1/responses",
  resourcePath: "/agent-connect/v1/responses",
});
const SCOPE = "responses";
const AUTHORIZATION_DETAIL_TYPE = "agent_connect";
const DEFAULT_MODEL = "openclaw/default";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_SAVED_CONNECTION_BYTES = 256 * 1024;
const MAX_STRING_LENGTH = 8 * 1024;
const MAX_EXPIRY_SECONDS = 10 * 365 * 24 * 60 * 60;
const DEFAULT_REFRESH_BEFORE_MS = 60_000;

export type OpenClawConnectionExperience = "tailscale" | "https";

export type OpenClawConnectionErrorCode =
  | "invalid_input"
  | "invalid_response"
  | "transport_error"
  | "discovery_failed"
  | "authorization_denied"
  | "authorization_failed"
  | "transaction_mismatch"
  | "token_exchange_failed"
  | "connection_expired"
  | "connection_changed"
  | "reauthorization_required"
  | "revocation_failed";

export class OpenClawConnectionError extends Error {
  readonly code: OpenClawConnectionErrorCode;
  readonly status: number | undefined;
  readonly oauthError: string | undefined;

  constructor(
    code: OpenClawConnectionErrorCode,
    message: string,
    options: {
      readonly status?: number;
      readonly oauthError?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "OpenClawConnectionError";
    this.code = code;
    this.status = options.status;
    this.oauthError = options.oauthError;
  }
}

export interface OpenClawProvider {
  readonly version: 1;
  readonly experience: OpenClawConnectionExperience;
  readonly origin: string;
  readonly issuer: string;
  readonly resource: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string;
  readonly pushedAuthorizationRequestEndpoint: string;
}

export interface DiscoverOpenClawProviderOptions {
  readonly providerUrl: string;
  readonly experience: OpenClawConnectionExperience;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export interface BeginOpenClawAuthorizationOptions {
  readonly provider: OpenClawProvider;
  readonly redirectUri: string;
  readonly tools: readonly ApplicationTool[];
  /** Caller-owned redirect context. It is never sent to OpenClaw. */
  readonly callerContext?: JsonObject;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export interface OpenClawAuthorizationTransaction {
  readonly version: 1;
  readonly experience: OpenClawConnectionExperience;
  readonly providerOrigin: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly state: string;
  /** PKCE secret. The caller must keep the transaction in session-scoped storage. */
  readonly codeVerifier: string;
  readonly requestUri: string;
  readonly applicationTools: readonly OpenClawApplicationTool[];
  readonly applicationToolsHash: string;
  /** Caller-owned redirect context. Serialized locally, never sent to OpenClaw. */
  readonly callerContext?: JsonObject;
}

export interface OpenClawAuthorizationStart {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
  readonly transaction: OpenClawAuthorizationTransaction;
}

export interface CompleteOpenClawAuthorizationOptions {
  readonly provider: OpenClawProvider;
  readonly redirectUri: string;
  readonly transaction: OpenClawAuthorizationTransaction;
  readonly callbackUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export interface OpenClawConnection {
  readonly version: 1;
  readonly providerOrigin: string;
  readonly endpoint: string;
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly refreshTokenExpiresAt: string;
  /** Fixed public alias; native OpenClaw agent/profile identifiers stay server-side. */
  readonly model: "openclaw/default";
  /** Exact application-tool snapshot approved with this connection. */
  readonly applicationTools: readonly OpenClawApplicationTool[];
  readonly applicationToolsHash: string;
}

export interface ParseOpenClawConnectionOptions {
  readonly clientId: string;
  readonly now?: number;
}

export interface OpenClawApplicationTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface RefreshOpenClawConnectionOptions {
  readonly connection: OpenClawConnection;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export interface RevokeOpenClawConnectionOptions {
  readonly connection: OpenClawConnection;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export interface CreateOpenClawAccessTokenGetterOptions {
  /** Read the caller-owned current connection. */
  readonly getConnection: () =>
    OpenClawConnection | Promise<OpenClawConnection>;
  /**
   * Atomically replace the caller-owned connection only if `expected` is still
   * current. Return false after disconnect or replacement; this prevents a
   * late refresh response from resurrecting an old connection.
   */
  readonly saveConnection: (
    connection: OpenClawConnection,
    expected: OpenClawConnection,
  ) => boolean | Promise<boolean>;
  readonly fetch?: typeof globalThis.fetch;
  readonly refreshBeforeMs?: number;
  readonly now?: () => number;
}

interface AuthorizationServerMetadata {
  readonly issuer: unknown;
  readonly authorization_endpoint: unknown;
  readonly token_endpoint: unknown;
  readonly revocation_endpoint: unknown;
  readonly pushed_authorization_request_endpoint: unknown;
  readonly response_types_supported: unknown;
  readonly grant_types_supported: unknown;
  readonly token_endpoint_auth_methods_supported: unknown;
  readonly code_challenge_methods_supported: unknown;
  readonly scopes_supported: unknown;
  readonly authorization_details_types_supported: unknown;
  readonly require_pushed_authorization_requests: unknown;
  readonly authorization_response_iss_parameter_supported: unknown;
}

interface ProtectedResourceMetadata {
  readonly resource: unknown;
  readonly authorization_servers: unknown;
  readonly scopes_supported: unknown;
  readonly bearer_methods_supported: unknown;
  readonly authorization_details_types_supported: unknown;
  readonly agent_connect_model: unknown;
}

interface TokenResponse {
  readonly access_token: unknown;
  readonly refresh_token: unknown;
  readonly token_type: unknown;
  readonly expires_in: unknown;
  readonly refresh_token_expires_in: unknown;
  readonly scope: unknown;
}

export async function discoverOpenClawProvider(
  options: DiscoverOpenClawProviderOptions,
): Promise<OpenClawProvider> {
  const { origin, issuer, layout } = canonicalProviderUrl(options.providerUrl);
  requireExperience(options.experience);
  const fetchImplementation = getFetch(options.fetch);
  const [authorizationMetadata, resourceMetadata] = await Promise.all([
    fetchJson<AuthorizationServerMetadata>(
      fetchImplementation,
      `${origin}${layout.authorizationServerMetadataPath}`,
      requestInit("GET", undefined, options.signal),
      "discovery_failed",
      "OpenClaw authorization metadata could not be loaded",
    ),
    fetchJson<ProtectedResourceMetadata>(
      fetchImplementation,
      `${origin}${layout.protectedResourceMetadataPath}`,
      requestInit("GET", undefined, options.signal),
      "discovery_failed",
      "OpenClaw protected-resource metadata could not be loaded",
    ),
  ]);

  const expected = {
    issuer,
    authorizationEndpoint: `${origin}${AUTHORIZATION_PATH}`,
    tokenEndpoint: `${origin}${TOKEN_PATH}`,
    revocationEndpoint: `${origin}${REVOCATION_PATH}`,
    parEndpoint: `${origin}${PAR_PATH}`,
    resource: `${origin}${layout.resourcePath}`,
  };
  if (
    authorizationMetadata.issuer !== expected.issuer ||
    authorizationMetadata.authorization_endpoint !==
      expected.authorizationEndpoint ||
    authorizationMetadata.token_endpoint !== expected.tokenEndpoint ||
    authorizationMetadata.revocation_endpoint !== expected.revocationEndpoint ||
    authorizationMetadata.pushed_authorization_request_endpoint !==
      expected.parEndpoint ||
    authorizationMetadata.require_pushed_authorization_requests !== true ||
    authorizationMetadata.authorization_response_iss_parameter_supported !==
      true ||
    !includesString(authorizationMetadata.response_types_supported, "code") ||
    !includesString(
      authorizationMetadata.grant_types_supported,
      "authorization_code",
    ) ||
    !includesString(
      authorizationMetadata.grant_types_supported,
      "refresh_token",
    ) ||
    !includesString(
      authorizationMetadata.token_endpoint_auth_methods_supported,
      "none",
    ) ||
    !includesString(
      authorizationMetadata.code_challenge_methods_supported,
      "S256",
    ) ||
    !includesString(authorizationMetadata.scopes_supported, SCOPE) ||
    !includesString(
      authorizationMetadata.authorization_details_types_supported,
      AUTHORIZATION_DETAIL_TYPE,
    ) ||
    resourceMetadata.resource !== expected.resource ||
    !includesString(resourceMetadata.authorization_servers, issuer) ||
    !includesString(resourceMetadata.scopes_supported, SCOPE) ||
    !includesString(resourceMetadata.bearer_methods_supported, "header") ||
    !includesString(
      resourceMetadata.authorization_details_types_supported,
      AUTHORIZATION_DETAIL_TYPE,
    ) ||
    resourceMetadata.agent_connect_model !== DEFAULT_MODEL
  ) {
    throw new OpenClawConnectionError(
      "discovery_failed",
      "OpenClaw metadata does not match the delegated Responses profile",
    );
  }

  return Object.freeze({
    version: 1,
    experience: options.experience,
    origin,
    issuer: expected.issuer,
    resource: expected.resource,
    authorizationEndpoint: expected.authorizationEndpoint,
    tokenEndpoint: expected.tokenEndpoint,
    revocationEndpoint: expected.revocationEndpoint,
    pushedAuthorizationRequestEndpoint: expected.parEndpoint,
  });
}

export async function beginOpenClawAuthorization(
  options: BeginOpenClawAuthorizationOptions,
): Promise<OpenClawAuthorizationStart> {
  requireCrypto();
  const provider = validateProvider(options.provider);
  const redirectUri = canonicalRedirectUri(options.redirectUri);
  const clientId = new URL(redirectUri).origin;
  const state = randomBase64Url(24);
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const applicationTools = snapshotApplicationTools(options.tools);
  const applicationToolsHash = await sha256Base64Url(
    canonicalJson(applicationTools),
  );
  const callerContext = snapshotCallerContext(options.callerContext);
  const authorizationDetails = JSON.stringify([
    {
      type: AUTHORIZATION_DETAIL_TYPE,
      application_tools: applicationTools,
    },
  ]);
  const body = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    resource: provider.resource,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    authorization_details: authorizationDetails,
  });
  if (new TextEncoder().encode(body.toString()).byteLength > MAX_JSON_BYTES) {
    throw invalidInput("OpenClaw authorization request is too large");
  }
  const created = await fetchJson<{
    request_uri: unknown;
    expires_in: unknown;
  }>(
    getFetch(options.fetch),
    provider.pushedAuthorizationRequestEndpoint,
    requestInit("POST", body, options.signal),
    "authorization_failed",
    "OpenClaw authorization could not be started",
  );
  const requestUri = requireBoundedString(created.request_uri, "request_uri");
  const expiresIn = requireExpirySeconds(created.expires_in, "expires_in");
  const authorizationUrl = new URL(provider.authorizationEndpoint);
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    request_uri: requestUri,
  }).toString();

  return {
    authorizationUrl: authorizationUrl.href,
    expiresAt: expiryDate(expiresIn),
    transaction: {
      version: 1,
      experience: provider.experience,
      providerOrigin: provider.origin,
      issuer: provider.issuer,
      clientId,
      redirectUri,
      resource: provider.resource,
      state,
      codeVerifier,
      requestUri,
      applicationTools,
      applicationToolsHash,
      ...(callerContext === undefined ? {} : { callerContext }),
    },
  };
}

export async function completeOpenClawAuthorization(
  options: CompleteOpenClawAuthorizationOptions,
): Promise<OpenClawConnection> {
  const provider = validateProvider(options.provider);
  const redirectUri = canonicalRedirectUri(options.redirectUri);
  const transaction = validateTransaction(options.transaction);
  const clientId = new URL(redirectUri).origin;
  if (
    transaction.experience !== provider.experience ||
    transaction.providerOrigin !== provider.origin ||
    transaction.issuer !== provider.issuer ||
    transaction.clientId !== clientId ||
    transaction.redirectUri !== redirectUri ||
    transaction.resource !== provider.resource
  ) {
    throw new OpenClawConnectionError(
      "transaction_mismatch",
      "OpenClaw authorization transaction does not match this provider and application",
    );
  }
  if (
    (await sha256Base64Url(canonicalJson(transaction.applicationTools))) !==
    transaction.applicationToolsHash
  ) {
    throw new OpenClawConnectionError(
      "transaction_mismatch",
      "OpenClaw authorization tool snapshot does not match the saved transaction",
    );
  }

  let callback: URL;
  try {
    callback = new URL(options.callbackUrl ?? globalThis.location.href);
  } catch {
    throw new OpenClawConnectionError(
      "transaction_mismatch",
      "OpenClaw authorization callback URL is invalid",
    );
  }
  validateCallback(
    callback,
    new URL(redirectUri),
    transaction.state,
    transaction.issuer,
  );
  const oauthError = callback.searchParams.get("error");
  if (oauthError !== null) {
    throw new OpenClawConnectionError(
      oauthError === "access_denied"
        ? "authorization_denied"
        : "authorization_failed",
      oauthError === "access_denied"
        ? "OpenClaw authorization was denied"
        : "OpenClaw authorization failed",
      { oauthError },
    );
  }
  const code = singleSearchParameter(callback.searchParams, "code");
  if (!code) {
    throw new OpenClawConnectionError(
      "transaction_mismatch",
      "OpenClaw authorization callback did not contain a code",
    );
  }
  const token = await requestToken(
    provider.tokenEndpoint,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: transaction.codeVerifier,
      client_id: clientId,
      redirect_uri: redirectUri,
      resource: provider.resource,
    }),
    getFetch(options.fetch),
    options.signal,
    "token_exchange_failed",
  );
  return connectionFromToken(
    provider.origin,
    provider.resource,
    clientId,
    transaction.applicationTools,
    transaction.applicationToolsHash,
    token,
  );
}

export async function refreshOpenClawConnection(
  options: RefreshOpenClawConnectionOptions,
): Promise<OpenClawConnection> {
  const connection = validateConnection(options.connection);
  if (Date.parse(connection.refreshTokenExpiresAt) <= Date.now()) {
    throw new OpenClawConnectionError(
      "connection_expired",
      "OpenClaw refresh token has expired; authorize it again",
    );
  }
  const tokenEndpoint = `${connection.providerOrigin}${TOKEN_PATH}`;
  let token: TokenResponse;
  try {
    token = await requestToken(
      tokenEndpoint,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: connection.refreshToken,
        client_id: connection.clientId,
        resource: connection.endpoint,
      }),
      getFetch(options.fetch),
      options.signal,
      "reauthorization_required",
    );
  } catch (error) {
    if (error instanceof OpenClawConnectionError) {
      throw reauthorizationRequired(
        "OpenClaw connection could not be refreshed; authorize it again",
        error.oauthError,
      );
    }
    throw error;
  }
  return connectionFromToken(
    connection.providerOrigin,
    connection.endpoint,
    connection.clientId,
    connection.applicationTools,
    connection.applicationToolsHash,
    token,
  );
}

export async function revokeOpenClawConnection(
  options: RevokeOpenClawConnectionOptions,
): Promise<void> {
  const connection = validateConnection(options.connection);
  await fetchEmpty(
    getFetch(options.fetch),
    `${connection.providerOrigin}${REVOCATION_PATH}`,
    requestInit(
      "POST",
      new URLSearchParams({
        token: connection.refreshToken,
        token_type_hint: "refresh_token",
        client_id: connection.clientId,
      }),
      options.signal,
    ),
    "revocation_failed",
    "OpenClaw connection could not be revoked",
  );
}

export function serializeOpenClawAuthorizationTransaction(
  transaction: OpenClawAuthorizationTransaction,
): string {
  return JSON.stringify(validateTransaction(transaction));
}

export function parseOpenClawAuthorizationTransaction(
  value: string,
): OpenClawAuthorizationTransaction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidInput("Invalid OpenClaw authorization transaction");
  }
  return validateTransaction(parsed);
}

/**
 * Parse and validate a caller-stored delegated connection. This checks the
 * exact record shape, supported endpoint layout and approved tool hash without
 * contacting the gateway. An expired access token remains restorable while its
 * refresh authority is current.
 */
export async function parseOpenClawConnection(
  serialized: string,
  options: ParseOpenClawConnectionOptions,
): Promise<OpenClawConnection> {
  if (
    !options ||
    typeof options !== "object" ||
    typeof options.clientId !== "string" ||
    typeof serialized !== "string" ||
    new TextEncoder().encode(serialized).byteLength > MAX_SAVED_CONNECTION_BYTES
  ) {
    throw invalidInput("Invalid saved OpenClaw connection");
  }
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) {
    throw invalidInput("OpenClaw connection validation time is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw invalidInput("Invalid saved OpenClaw connection");
  }
  const connection = validateSavedConnection(parsed, options.clientId);
  if (Date.parse(connection.refreshTokenExpiresAt) <= now) {
    throw new OpenClawConnectionError(
      "connection_expired",
      "Saved OpenClaw authorization expired; authorize it again",
    );
  }
  if (
    (await sha256Base64Url(canonicalJson(connection.applicationTools))) !==
    connection.applicationToolsHash
  ) {
    throw invalidInput(
      "Saved OpenClaw application tools did not match approval",
    );
  }
  return connection;
}

export function serializeOpenClawConnection(
  connection: OpenClawConnection,
): string {
  const serialized = JSON.stringify(validateConnection(connection));
  if (
    new TextEncoder().encode(serialized).byteLength > MAX_SAVED_CONNECTION_BYTES
  ) {
    throw invalidInput("Saved OpenClaw connection is too large");
  }
  return serialized;
}

export function getOpenClawConnectionProviderUrl(
  connection: OpenClawConnection,
): string {
  const validated = validateConnection(connection);
  const origin = validated.providerOrigin;
  return validated.endpoint === `${origin}${STOCK_PLUGIN_LAYOUT.resourcePath}`
    ? `${origin}${STOCK_PLUGIN_LAYOUT.issuerPath}`
    : origin;
}

export function normalizeOpenClawProviderUrl(value: string): string {
  return canonicalProviderUrl(value).issuer;
}

/**
 * Create a single-flight, proactive-refresh bearer getter for
 * createAiSdkOpenResponsesModel. A failed or ambiguously completed refresh is
 * never replayed: the application must authorize again, retaining any draft.
 */
export function createOpenClawAccessTokenGetter(
  options: CreateOpenClawAccessTokenGetterOptions,
): (signal?: AbortSignal) => Promise<string> {
  const refreshBeforeMs = options.refreshBeforeMs ?? DEFAULT_REFRESH_BEFORE_MS;
  if (!Number.isFinite(refreshBeforeMs) || refreshBeforeMs < 0) {
    throw invalidInput(
      "OpenClaw refreshBeforeMs must be a non-negative number",
    );
  }
  const now = options.now ?? Date.now;
  let inFlight: Promise<OpenClawConnection> | undefined;
  let terminalFailure: OpenClawConnectionError | undefined;

  return async (signal?: AbortSignal): Promise<string> => {
    signal?.throwIfAborted();
    if (terminalFailure) throw terminalFailure;
    const current = validateConnection(await options.getConnection());
    signal?.throwIfAborted();
    if (Date.parse(current.expiresAt) > now() + refreshBeforeMs) {
      return current.accessToken;
    }
    if (Date.parse(current.refreshTokenExpiresAt) <= now()) {
      terminalFailure = new OpenClawConnectionError(
        "connection_expired",
        "OpenClaw refresh token has expired; authorize it again",
      );
      throw terminalFailure;
    }

    if (!inFlight) {
      const refreshOptions: RefreshOpenClawConnectionOptions = {
        connection: current,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      };
      let attempt: Promise<OpenClawConnection>;
      attempt = refreshOpenClawConnection(refreshOptions)
        .then(async (refreshed) => {
          let saved: boolean;
          try {
            saved = await options.saveConnection(refreshed, current);
          } catch {
            throw reauthorizationRequired(
              "The rotated OpenClaw credential could not be saved; authorize it again",
            );
          }
          if (!saved) {
            throw new OpenClawConnectionError(
              "connection_changed",
              "OpenClaw connection changed while its credential was refreshing",
            );
          }
          return refreshed;
        })
        .catch((error: unknown) => {
          terminalFailure =
            error instanceof OpenClawConnectionError &&
            error.code === "connection_changed"
              ? error
              : error instanceof OpenClawConnectionError
                ? reauthorizationRequired(error.message, error.oauthError)
                : reauthorizationRequired(
                    "OpenClaw connection could not be refreshed; authorize it again",
                  );
          throw terminalFailure;
        })
        .finally(() => {
          if (inFlight === attempt) inFlight = undefined;
        });
      inFlight = attempt;
    }
    const refreshed = await waitForPromise(inFlight, signal);
    return refreshed.accessToken;
  };
}

function connectionFromToken(
  providerOrigin: string,
  endpoint: string,
  clientId: string,
  applicationTools: readonly OpenClawApplicationTool[],
  applicationToolsHash: string,
  response: TokenResponse,
): OpenClawConnection {
  const fixedApplicationTools = cloneApplicationTools(applicationTools);
  const accessToken = requireBoundedString(
    response.access_token,
    "access_token",
  );
  const refreshToken = requireBoundedString(
    response.refresh_token,
    "refresh_token",
  );
  if (response.token_type !== "Bearer" || response.scope !== SCOPE) {
    throw new OpenClawConnectionError(
      "token_exchange_failed",
      "OpenClaw returned an unsupported token profile",
    );
  }
  const expiresIn = requireExpirySeconds(response.expires_in, "expires_in");
  const refreshExpiresIn = requireExpirySeconds(
    response.refresh_token_expires_in,
    "refresh_token_expires_in",
  );
  return Object.freeze({
    version: 1,
    providerOrigin,
    endpoint,
    clientId,
    accessToken,
    refreshToken,
    expiresAt: expiryDate(expiresIn),
    refreshTokenExpiresAt: expiryDate(refreshExpiresIn),
    model: DEFAULT_MODEL,
    applicationTools: fixedApplicationTools,
    applicationToolsHash,
  });
}

async function requestToken(
  endpoint: string,
  body: URLSearchParams,
  fetchImplementation: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
  errorCode: OpenClawConnectionErrorCode,
): Promise<TokenResponse> {
  return fetchJson<TokenResponse>(
    fetchImplementation,
    endpoint,
    requestInit("POST", body, signal),
    errorCode,
    "OpenClaw token request failed",
  );
}

function validateProvider(provider: OpenClawProvider): OpenClawProvider {
  if (!provider || typeof provider !== "object" || provider.version !== 1) {
    throw invalidInput("Invalid OpenClaw provider");
  }
  const origin = canonicalHttpsOrigin(provider.origin);
  const layout = layoutForIssuer(origin, provider.issuer);
  requireExperience(provider.experience);
  if (
    provider.resource !== `${origin}${layout.resourcePath}` ||
    provider.authorizationEndpoint !== `${origin}${AUTHORIZATION_PATH}` ||
    provider.tokenEndpoint !== `${origin}${TOKEN_PATH}` ||
    provider.revocationEndpoint !== `${origin}${REVOCATION_PATH}` ||
    provider.pushedAuthorizationRequestEndpoint !== `${origin}${PAR_PATH}`
  ) {
    throw invalidInput("Invalid OpenClaw provider metadata");
  }
  return provider;
}

function validateTransaction(value: unknown): OpenClawAuthorizationTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInput("Invalid OpenClaw authorization transaction");
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "version",
    "experience",
    "providerOrigin",
    "issuer",
    "clientId",
    "redirectUri",
    "resource",
    "state",
    "codeVerifier",
    "requestUri",
    "applicationTools",
    "applicationToolsHash",
    "callerContext",
  ];
  if (
    record.version !== 1 ||
    (record.experience !== "tailscale" && record.experience !== "https") ||
    Object.keys(record).some((key) => !keys.includes(key)) ||
    keys.slice(2, 10).some((key) => !isBoundedString(record[key])) ||
    typeof record.applicationToolsHash !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.applicationToolsHash)
  ) {
    throw invalidInput("Invalid OpenClaw authorization transaction");
  }
  const transaction = record as unknown as OpenClawAuthorizationTransaction;
  const origin = canonicalHttpsOrigin(transaction.providerOrigin);
  const layout = layoutForIssuer(origin, transaction.issuer);
  if (
    transaction.resource !== `${origin}${layout.resourcePath}` ||
    canonicalRedirectUri(transaction.redirectUri) !== transaction.redirectUri ||
    new URL(transaction.redirectUri).origin !== transaction.clientId ||
    transaction.codeVerifier.length < 43 ||
    transaction.codeVerifier.length > 128 ||
    !validApplicationTools(transaction.applicationTools) ||
    !validCallerContext(transaction.callerContext)
  ) {
    throw invalidInput("Invalid OpenClaw authorization transaction");
  }
  return transaction;
}

function validateConnection(value: OpenClawConnection): OpenClawConnection {
  if (!value || typeof value !== "object" || value.version !== 1) {
    throw invalidInput("Invalid OpenClaw connection");
  }
  const origin = canonicalHttpsOrigin(value.providerOrigin);
  if (
    ![STANDALONE_LAYOUT, STOCK_PLUGIN_LAYOUT].some(
      (layout) => value.endpoint === `${origin}${layout.resourcePath}`,
    ) ||
    canonicalHttpsOrigin(value.clientId) !== value.clientId ||
    value.model !== DEFAULT_MODEL ||
    !isBoundedString(value.accessToken) ||
    !isBoundedString(value.refreshToken) ||
    !validDate(value.expiresAt) ||
    !validDate(value.refreshTokenExpiresAt) ||
    !validApplicationTools(value.applicationTools) ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.applicationToolsHash)
  ) {
    throw invalidInput("Invalid OpenClaw connection");
  }
  return value;
}

function validateSavedConnection(
  value: unknown,
  expectedClientId: string,
): OpenClawConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInput("Invalid saved OpenClaw connection");
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "version",
    "providerOrigin",
    "endpoint",
    "clientId",
    "accessToken",
    "refreshToken",
    "expiresAt",
    "refreshTokenExpiresAt",
    "model",
    "applicationTools",
    "applicationToolsHash",
  ];
  if (
    record.version !== 1 ||
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key)) ||
    typeof record.providerOrigin !== "string" ||
    typeof record.endpoint !== "string" ||
    typeof record.clientId !== "string"
  ) {
    throw invalidInput("Invalid saved OpenClaw connection");
  }
  const connection = validateConnection(
    record as unknown as OpenClawConnection,
  );
  if (connection.clientId !== canonicalHttpsOrigin(expectedClientId)) {
    throw invalidInput(
      "Saved OpenClaw connection belongs to another application",
    );
  }
  const applicationTools = cloneApplicationTools(connection.applicationTools);
  try {
    for (const tool of applicationTools) createToolValidator(tool.inputSchema);
  } catch {
    throw invalidInput("Invalid saved OpenClaw application tool schema");
  }
  return deepFreeze({
    version: 1,
    providerOrigin: connection.providerOrigin,
    endpoint: connection.endpoint,
    clientId: connection.clientId,
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    expiresAt: connection.expiresAt,
    refreshTokenExpiresAt: connection.refreshTokenExpiresAt,
    model: DEFAULT_MODEL,
    applicationTools,
    applicationToolsHash: connection.applicationToolsHash,
  });
}

function validateCallback(
  callback: URL,
  redirect: URL,
  state: string,
  issuer: string,
): void {
  if (
    callback.username ||
    callback.password ||
    callback.hash ||
    callback.origin !== redirect.origin ||
    callback.pathname !== redirect.pathname ||
    singleSearchParameter(callback.searchParams, "state") !== state ||
    singleSearchParameter(callback.searchParams, "iss") !== issuer
  ) {
    throw new OpenClawConnectionError(
      "transaction_mismatch",
      "OpenClaw authorization callback did not match the saved transaction",
    );
  }
  for (const [key, value] of redirect.searchParams) {
    if (callback.searchParams.get(key) !== value) {
      throw new OpenClawConnectionError(
        "transaction_mismatch",
        "OpenClaw authorization callback did not match the redirect URI",
      );
    }
  }
  const hasCode = callback.searchParams.has("code");
  const hasError = callback.searchParams.has("error");
  if (hasCode === hasError) {
    throw new OpenClawConnectionError(
      "transaction_mismatch",
      "OpenClaw authorization callback must contain exactly one result",
    );
  }
  for (const key of new Set(callback.searchParams.keys())) {
    if (
      !redirect.searchParams.has(key) &&
      key !== "state" &&
      key !== "code" &&
      key !== "error" &&
      key !== "error_description" &&
      key !== "iss"
    ) {
      throw new OpenClawConnectionError(
        "transaction_mismatch",
        "OpenClaw authorization callback contained unexpected parameters",
      );
    }
    singleSearchParameter(callback.searchParams, key);
  }
}

function snapshotApplicationTools(
  tools: readonly ApplicationTool[],
): readonly OpenClawApplicationTool[] {
  if (!Array.isArray(tools) || tools.length > 32) {
    throw invalidInput(
      "OpenClaw authorization accepts at most 32 application tools",
    );
  }
  const names = new Set<string>();
  return deepFreeze(
    tools.map((tool) => {
      if (
        !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(tool.name) ||
        !tool.description ||
        tool.description.length > 2_000 ||
        names.has(tool.name)
      ) {
        throw invalidInput("Invalid OpenClaw application tool definition");
      }
      names.add(tool.name);
      let inputSchema: unknown;
      try {
        inputSchema = JSON.parse(JSON.stringify(tool.inputSchema));
      } catch {
        throw invalidInput("Invalid OpenClaw application tool input schema");
      }
      if (
        !inputSchema ||
        typeof inputSchema !== "object" ||
        Array.isArray(inputSchema)
      ) {
        throw invalidInput("Invalid OpenClaw application tool input schema");
      }
      return deepFreeze({
        name: tool.name,
        description: tool.description,
        inputSchema: inputSchema as JsonObject,
      });
    }),
  );
}

function validApplicationTools(
  value: unknown,
): value is readonly OpenClawApplicationTool[] {
  if (!Array.isArray(value) || value.length > 32) {
    return false;
  }
  const names = new Set<string>();
  return value.every((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return false;
    }
    const record = candidate as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) =>
          key !== "name" && key !== "description" && key !== "inputSchema",
      ) ||
      typeof record.name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(record.name) ||
      names.has(record.name) ||
      typeof record.description !== "string" ||
      !record.description ||
      record.description.length > 2_000 ||
      !record.inputSchema ||
      typeof record.inputSchema !== "object" ||
      Array.isArray(record.inputSchema)
    ) {
      return false;
    }
    names.add(record.name);
    return true;
  });
}

function cloneApplicationTools(
  value: readonly OpenClawApplicationTool[],
): readonly OpenClawApplicationTool[] {
  let clone: unknown;
  try {
    clone = JSON.parse(JSON.stringify(value));
  } catch {
    throw invalidInput("Invalid OpenClaw application tool snapshot");
  }
  if (!validApplicationTools(clone)) {
    throw invalidInput("Invalid OpenClaw application tool snapshot");
  }
  return deepFreeze(clone);
}

function snapshotCallerContext(
  value: JsonObject | undefined,
): JsonObject | undefined {
  if (value === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalidInput("Invalid OpenClaw caller context");
  }
  if (
    !serialized ||
    new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES
  ) {
    throw invalidInput("OpenClaw caller context is too large");
  }
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidInput("Invalid OpenClaw caller context");
  }
  return deepFreeze(parsed as JsonObject);
}

function validCallerContext(value: unknown): value is JsonObject | undefined {
  if (value === undefined) return true;
  try {
    const serialized = JSON.stringify(value);
    return (
      Boolean(serialized) &&
      new TextEncoder().encode(serialized).byteLength <= MAX_JSON_BYTES &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    );
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function canonicalHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidInput("OpenClaw provider must be a canonical HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw invalidInput("OpenClaw provider must be a canonical HTTPS origin");
  }
  return url.origin;
}

function canonicalProviderUrl(value: string): {
  readonly origin: string;
  readonly issuer: string;
  readonly layout: ProviderEndpointLayout;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidInput("OpenClaw provider must be a canonical HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw invalidInput("OpenClaw provider must be a canonical HTTPS URL");
  }
  const layout =
    url.pathname === "/"
      ? STANDALONE_LAYOUT
      : url.pathname === STOCK_PLUGIN_LAYOUT.issuerPath
        ? STOCK_PLUGIN_LAYOUT
        : undefined;
  if (!layout) {
    throw invalidInput(
      "OpenClaw provider must be an HTTPS origin or its /agent-connect issuer",
    );
  }
  const issuer = `${url.origin}${layout.issuerPath}`;
  if (
    value !== (layout.issuerPath ? issuer : url.origin) &&
    !(layout.issuerPath === "" && value === `${url.origin}/`)
  ) {
    throw invalidInput("OpenClaw provider URL is not canonical");
  }
  return { origin: url.origin, issuer, layout };
}

function layoutForIssuer(
  origin: string,
  issuer: string,
): ProviderEndpointLayout {
  if (issuer === origin) return STANDALONE_LAYOUT;
  if (issuer === `${origin}${STOCK_PLUGIN_LAYOUT.issuerPath}`) {
    return STOCK_PLUGIN_LAYOUT;
  }
  throw invalidInput("Invalid OpenClaw issuer");
}

function canonicalRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidInput("OpenClaw redirect URI must use HTTPS");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw invalidInput(
      "OpenClaw redirect URI must use HTTPS without credentials or a fragment",
    );
  }
  return url.href;
}

function getFetch(
  implementation: typeof globalThis.fetch | undefined,
): typeof globalThis.fetch {
  const result = implementation ?? globalThis.fetch;
  if (typeof result !== "function") {
    throw invalidInput("Fetch is required for an OpenClaw connection");
  }
  return result.bind(globalThis);
}

async function fetchJson<T>(
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  code: OpenClawConnectionErrorCode,
  message: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      ...init,
      credentials: "omit",
      redirect: "error",
      headers: {
        Accept: "application/json",
        ...(init.body instanceof URLSearchParams
          ? {
              "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            }
          : {}),
      },
    });
  } catch {
    throw new OpenClawConnectionError("transport_error", message);
  }
  const json = await readJson(response, code, message);
  if (!response.ok) {
    const oauthError = oauthErrorFrom(json);
    throw new OpenClawConnectionError(code, message, {
      status: response.status,
      ...(oauthError ? { oauthError } : {}),
    });
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new OpenClawConnectionError(code, `${message}: invalid response`);
  }
  return json as T;
}

async function fetchEmpty(
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  code: OpenClawConnectionErrorCode,
  message: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      ...init,
      credentials: "omit",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
    });
  } catch {
    throw new OpenClawConnectionError("transport_error", message);
  }
  if (response.ok) {
    if (response.body) {
      const body = await readBoundedText(response, code, message);
      if (body)
        throw new OpenClawConnectionError(code, `${message}: invalid response`);
    }
    return;
  }
  const json = await readJson(response, code, message);
  const oauthError = oauthErrorFrom(json);
  throw new OpenClawConnectionError(code, message, {
    status: response.status,
    ...(oauthError ? { oauthError } : {}),
  });
}

async function readJson(
  response: Response,
  code: OpenClawConnectionErrorCode,
  message: string,
): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new OpenClawConnectionError(code, `${message}: invalid response`);
  }
  const text = await readBoundedText(response, code, message);
  try {
    return JSON.parse(text);
  } catch {
    throw new OpenClawConnectionError(code, `${message}: invalid response`);
  }
}

async function readBoundedText(
  response: Response,
  code: OpenClawConnectionErrorCode,
  message: string,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw new OpenClawConnectionError(code, `${message}: response too large`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new OpenClawConnectionError(code, `${message}: response too large`);
    }
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

function oauthErrorFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const error = (value as Record<string, unknown>).error;
  return isBoundedString(error) ? error : undefined;
}

function requireBoundedString(value: unknown, name: string): string {
  if (!isBoundedString(value)) {
    throw new OpenClawConnectionError(
      "token_exchange_failed",
      `OpenClaw returned an invalid ${name}`,
    );
  }
  return value;
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_STRING_LENGTH
  );
}

function requireExpirySeconds(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_EXPIRY_SECONDS
  ) {
    throw new OpenClawConnectionError(
      "token_exchange_failed",
      `OpenClaw returned an invalid ${name}`,
    );
  }
  return value;
}

function expiryDate(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function includesString(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.includes(expected);
}

function requireExperience(
  value: unknown,
): asserts value is OpenClawConnectionExperience {
  if (value !== "tailscale" && value !== "https") {
    throw invalidInput("Invalid OpenClaw connection experience");
  }
}

function requireCrypto(): void {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new OpenClawConnectionError(
      "invalid_input",
      "Web Crypto is required for OpenClaw authorization",
    );
  }
}

function randomBase64Url(bytes: number): string {
  const value = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(value);
  return encodeBase64Url(value);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return globalThis
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function singleSearchParameter(
  parameters: URLSearchParams,
  name: string,
): string | null {
  const values = parameters.getAll(name);
  if (values.length !== 1 || !isBoundedString(values[0])) {
    if (values.length === 0) return null;
    throw new OpenClawConnectionError(
      "transaction_mismatch",
      "OpenClaw authorization callback contained invalid parameters",
    );
  }
  return values[0] ?? null;
}

async function waitForPromise<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function invalidInput(message: string): OpenClawConnectionError {
  return new OpenClawConnectionError("invalid_input", message);
}

function reauthorizationRequired(
  message: string,
  oauthError?: string,
): OpenClawConnectionError {
  return new OpenClawConnectionError("reauthorization_required", message, {
    ...(oauthError ? { oauthError } : {}),
  });
}

function requestInit(
  method: "GET" | "POST",
  body: URLSearchParams | undefined,
  signal: AbortSignal | undefined,
): RequestInit {
  return {
    method,
    ...(body === undefined ? {} : { body }),
    ...(signal === undefined ? {} : { signal }),
  };
}
