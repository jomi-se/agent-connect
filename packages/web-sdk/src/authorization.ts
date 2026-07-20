import { AgentConnectError } from "./agent-session.js";
import type {
  AgentAuthorizationGrant,
  AgentAuthorizationStart,
  AgentAuthorizationTransaction,
  BeginAgentAuthorizationOptions,
  CompleteAgentAuthorizationOptions,
  RuntimeCard,
  RevokeAgentAuthorizationOptions,
} from "./types.js";

interface RuntimeChallengeResponse {
  readonly runtimeCard: RuntimeCard;
  readonly nonce: string;
  readonly signature: string;
}

export async function beginAgentAuthorization(
  options: BeginAgentAuthorizationOptions,
): Promise<AgentAuthorizationStart> {
  requireCrypto();
  const fetchImplementation =
    options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = normalizeEndpoint(options.runtimeCard.endpoint);
  const nonce = randomBase64Url(24);
  const challengeResponse = await fetchImplementation(
    `${baseUrl}/v1/runtime-challenges`,
    requestOptions(options, {
      method: "POST",
      body: JSON.stringify({ nonce }),
    }),
  );
  const challenge = await requireJson<RuntimeChallengeResponse>(
    challengeResponse,
    "Failed to verify Agent Connect runtime",
  );
  await verifyChallenge(options.runtimeCard, challenge, nonce);

  const codeVerifier = randomBase64Url(32);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = randomBase64Url(24);
  const scopes = ["agent:prompt", "agent:result", "tools:invoke"];
  const response = await fetchImplementation(
    `${baseUrl}/v1/authorization-requests`,
    requestOptions(options, {
      method: "POST",
      body: JSON.stringify({
        appId: options.appId,
        redirectUri: options.redirectUri,
        state,
        codeChallenge,
        scopes,
        tools: options.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      }),
    }),
  );
  const created = await requireJson<{
    requestId: string;
    authorizeUrl: string;
    expiresAt: string;
  }>(response, "Failed to create Agent Connect authorization request");
  const authorizeUrl = new URL(created.authorizeUrl);
  if (authorizeUrl.origin !== new URL(baseUrl).origin) {
    throw new AgentConnectError(
      "runtime_identity_mismatch",
      "Gateway returned an authorization URL on another origin",
    );
  }
  return {
    authorizeUrl: authorizeUrl.toString(),
    expiresAt: created.expiresAt,
    transaction: {
      version: 1,
      runtimeId: options.runtimeCard.runtimeId,
      appId: options.appId,
      redirectUri: options.redirectUri,
      state,
      codeVerifier,
      requestId: created.requestId,
    },
  };
}

export async function completeAgentAuthorization(
  options: CompleteAgentAuthorizationOptions,
): Promise<AgentAuthorizationGrant> {
  const callback = new URL(options.callbackUrl ?? globalThis.location.href);
  const redirect = new URL(options.redirectUri);
  if (
    callback.origin !== redirect.origin ||
    callback.pathname !== redirect.pathname
  ) {
    throw new AgentConnectError(
      "protocol_error",
      "Agent Connect authorization callback arrived at an unexpected URL",
    );
  }
  const state = callback.searchParams.get("state");
  if (
    !state ||
    !constantTimeTextEqual(state, options.transaction.state) ||
    options.transaction.runtimeId !== options.runtimeCard.runtimeId ||
    options.transaction.appId !== options.appId ||
    options.transaction.redirectUri !== options.redirectUri
  ) {
    throw new AgentConnectError(
      "protocol_error",
      "Agent Connect authorization response did not match the saved transaction",
    );
  }
  const error = callback.searchParams.get("error");
  if (error) {
    throw new AgentConnectError(
      error === "access_denied" ? "authorization_denied" : "protocol_error",
      `Agent Connect authorization failed: ${error}`,
    );
  }
  const code = callback.searchParams.get("code");
  if (!code) {
    throw new AgentConnectError(
      "protocol_error",
      "Agent Connect authorization response did not match the saved transaction",
    );
  }
  const fetchImplementation =
    options.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImplementation(
    `${normalizeEndpoint(options.runtimeCard.endpoint)}/oauth/token`,
    requestOptions(options, {
      method: "POST",
      body: JSON.stringify({
        code,
        codeVerifier: options.transaction.codeVerifier,
        appId: options.appId,
        redirectUri: options.redirectUri,
      }),
    }),
  );
  return requireJson<AgentAuthorizationGrant>(
    response,
    "Failed to exchange Agent Connect authorization code",
  );
}

export async function revokeAgentAuthorization(
  options: RevokeAgentAuthorizationOptions,
): Promise<void> {
  const fetchImplementation =
    options.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImplementation(
    `${normalizeEndpoint(options.baseUrl)}/oauth/revoke`,
    requestOptions(options, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.accessToken}` },
      body: JSON.stringify({ appId: options.appId }),
    }),
  );
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new AgentConnectError(
      "http_error",
      `Failed to revoke Agent Connect authorization: HTTP ${response.status}${body ? ` — ${body}` : ""}`,
      { status: response.status },
    );
  }
}

export function serializeAuthorizationTransaction(
  transaction: AgentAuthorizationTransaction,
): string {
  return JSON.stringify(transaction);
}

export function parseAuthorizationTransaction(
  value: string,
): AgentAuthorizationTransaction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Invalid Agent Connect authorization transaction");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>)["version"] !== 1 ||
    ![
      "runtimeId",
      "appId",
      "redirectUri",
      "state",
      "codeVerifier",
      "requestId",
    ].every(
      (key) => typeof (parsed as Record<string, unknown>)[key] === "string",
    )
  ) {
    throw new TypeError("Invalid Agent Connect authorization transaction");
  }
  return parsed as AgentAuthorizationTransaction;
}

async function verifyChallenge(
  expected: RuntimeCard,
  challenge: RuntimeChallengeResponse,
  nonce: string,
): Promise<void> {
  if (
    challenge.nonce !== nonce ||
    challenge.runtimeCard.runtimeId !== expected.runtimeId ||
    normalizeEndpoint(challenge.runtimeCard.endpoint) !==
      normalizeEndpoint(expected.endpoint)
  ) {
    throw new AgentConnectError(
      "runtime_identity_mismatch",
      "The endpoint did not present the enrolled Agent Connect runtime",
    );
  }
  let key: CryptoKey;
  try {
    key = await globalThis.crypto.subtle.importKey(
      "jwk",
      expected.connectorPublicKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    throw new AgentConnectError(
      "protocol_error",
      "This browser cannot verify the gateway identity key",
    );
  }
  const payload = JSON.stringify({
    version: challenge.runtimeCard.version,
    runtimeId: challenge.runtimeCard.runtimeId,
    endpoint: challenge.runtimeCard.endpoint,
    nonce,
  });
  const valid = await globalThis.crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    decodeBase64Url(challenge.signature),
    new TextEncoder().encode(payload),
  );
  if (!valid) {
    throw new AgentConnectError(
      "runtime_identity_mismatch",
      "The endpoint could not prove possession of the enrolled gateway key",
    );
  }
}

function requestOptions(
  options: {
    headers?: Readonly<Record<string, string>>;
    credentials?: RequestCredentials;
  },
  init: RequestInit,
): RequestInit {
  return {
    ...init,
    headers: {
      ...options.headers,
      ...init.headers,
      "Content-Type": "application/json",
    },
    credentials: options.credentials ?? "same-origin",
  };
}

async function requireJson<T>(response: Response, message: string): Promise<T> {
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new AgentConnectError(
      "http_error",
      `${message}: HTTP ${response.status}${body ? ` — ${body}` : ""}`,
      { status: response.status },
    );
  }
  return (await response.json()) as T;
}

function normalizeEndpoint(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new TypeError("Agent Connect runtime endpoint must use HTTPS");
  }
  return parsed.toString().replace(/\/$/, "");
}

function requireCrypto(): void {
  if (!globalThis.crypto?.subtle) {
    throw new AgentConnectError(
      "protocol_error",
      "Web Crypto is required for Agent Connect enrollment",
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
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string): ArrayBuffer {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function constantTimeTextEqual(actual: string, expected: string): boolean {
  const length = Math.max(actual.length, expected.length);
  let difference = actual.length ^ expected.length;
  for (let index = 0; index < length; index += 1) {
    difference |=
      (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}
