import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign,
  timingSafeEqual,
  type JsonWebKey,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { hashToolSnapshot, validateToolSnapshot } from "./tool-snapshot.js";

export interface RuntimeCard {
  readonly version: 1;
  readonly runtimeId: string;
  readonly endpoint: string;
  readonly connectorPublicKey: JsonWebKey;
  readonly transportProfile: string;
  readonly authorizationServer: string;
}

export interface EnrollmentBundle {
  readonly runtimeCard: RuntimeCard;
  readonly enrollmentPassphrase: string;
}

export interface ConnectorAuthOptions {
  readonly statePath: string;
  readonly publicEndpoint: string;
  readonly transportProfile?: string;
  readonly enrollmentPassphrase?: string;
  readonly grantTtlSeconds?: number;
  readonly deviceTtlSeconds?: number;
  readonly now?: () => number;
  readonly onEnrollmentBundle?: (bundle: EnrollmentBundle) => void;
}

export interface AuthorizationRequestInput {
  readonly origin: string;
  readonly appId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
  readonly tools: unknown;
}

export interface PendingAuthorization {
  readonly id: string;
  readonly origin: string;
  readonly appId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
  readonly toolHash: string;
  readonly toolNames: readonly string[];
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
  }[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface GrantView {
  readonly id: string;
  readonly origin: string;
  readonly appId: string;
  readonly scopes: readonly string[];
  readonly toolHash: string;
  readonly toolNames: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

interface StoredGrant {
  readonly id: string;
  readonly tokenHash: string;
  readonly origin: string;
  readonly appId: string;
  readonly scopes: readonly string[];
  readonly toolHash: string;
  readonly toolNames: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
  revokedAt?: number;
}

interface StoredDevice {
  readonly id: string;
  readonly tokenHash: string;
  readonly tailscaleUser: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  revokedAt?: number;
}

interface StoredConnectorState {
  readonly version: 1;
  readonly runtimeId: string;
  readonly connectorPrivateKey: JsonWebKey;
  readonly connectorPublicKey: JsonWebKey;
  readonly enrollmentSalt: string;
  readonly enrollmentVerifier: string;
  readonly capabilitySigningSecret: string;
  readonly grants: StoredGrant[];
  readonly devices: StoredDevice[];
}

interface AuthorizationCode {
  readonly value: string;
  readonly request: PendingAuthorization;
  readonly createdAt: number;
  readonly expiresAt: number;
}

const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 2 * 60 * 1000;
const ALLOWED_SCOPES = new Set([
  "agent:prompt",
  "agent:result",
  "tools:invoke",
]);
const REQUIRED_SCOPES = [...ALLOWED_SCOPES].sort();

export class ConnectorAuth {
  readonly runtimeCard: RuntimeCard;
  readonly capabilitySigningSecret: string;

  private readonly statePath: string;
  private readonly now: () => number;
  private readonly grantTtlSeconds: number;
  private readonly deviceTtlSeconds: number;
  private state: StoredConnectorState;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly failedPassphrases = new Map<
    string,
    { count: number; resetAt: number }
  >();

  constructor(options: ConnectorAuthOptions) {
    this.statePath = options.statePath;
    this.now = options.now ?? Date.now;
    this.grantTtlSeconds = options.grantTtlSeconds ?? 30 * 24 * 60 * 60;
    this.deviceTtlSeconds = options.deviceTtlSeconds ?? 365 * 24 * 60 * 60;
    const loaded = loadState(options.statePath);
    if (loaded) {
      this.state = loaded;
    } else {
      const passphrase =
        options.enrollmentPassphrase ?? createEnrollmentPassphrase();
      this.state = createState(passphrase);
      this.persist();
      options.onEnrollmentBundle?.({
        runtimeCard: makeRuntimeCard(this.state, options),
        enrollmentPassphrase: passphrase,
      });
    }
    this.runtimeCard = makeRuntimeCard(this.state, options);
    this.capabilitySigningSecret = this.state.capabilitySigningSecret;
  }

  createChallenge(nonce: string): {
    runtimeCard: RuntimeCard;
    nonce: string;
    signature: string;
  } {
    if (!isBase64Url(nonce, 16, 128)) {
      throw new ConnectorAuthError("invalid_nonce");
    }
    const payload = challengePayload(this.runtimeCard, nonce);
    const signature = sign(
      null,
      Buffer.from(payload),
      createPrivateKey({ key: this.state.connectorPrivateKey, format: "jwk" }),
    ).toString("base64url");
    return { runtimeCard: this.runtimeCard, nonce, signature };
  }

  createAuthorizationRequest(
    input: AuthorizationRequestInput,
  ): PendingAuthorization {
    requireAppId(input.appId);
    requireRedirect(input.redirectUri, input.origin);
    if (!isBase64Url(input.state, 16, 256)) {
      throw new ConnectorAuthError("invalid_state");
    }
    if (!isBase64Url(input.codeChallenge, 43, 128)) {
      throw new ConnectorAuthError("invalid_code_challenge");
    }
    const requestedScopes = [...input.scopes].sort();
    if (
      requestedScopes.length !== REQUIRED_SCOPES.length ||
      requestedScopes.some((scope, index) => scope !== REQUIRED_SCOPES[index])
    ) {
      throw new ConnectorAuthError("invalid_scope");
    }
    const tools = validateToolSnapshot(input.tools);
    const now = this.now();
    const request: PendingAuthorization = {
      id: `ar_${randomBytes(18).toString("base64url")}`,
      origin: input.origin,
      appId: input.appId,
      redirectUri: input.redirectUri,
      state: input.state,
      codeChallenge: input.codeChallenge,
      scopes: requestedScopes,
      toolHash: hashToolSnapshot(tools),
      toolNames: tools.map((tool) => tool.name),
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      createdAt: now,
      expiresAt: now + AUTHORIZATION_TTL_MS,
    };
    this.pending.set(request.id, request);
    return request;
  }

  getPending(id: string): PendingAuthorization | undefined {
    const request = this.pending.get(id);
    if (!request) return undefined;
    if (request.expiresAt <= this.now()) {
      this.pending.delete(id);
      return undefined;
    }
    return request;
  }

  isDeviceEnrolled(token: string | undefined, tailscaleUser: string): boolean {
    if (!token) return false;
    const tokenHash = sha256(token);
    const now = this.now();
    return this.state.devices.some(
      (device) =>
        device.tokenHash === tokenHash &&
        device.tailscaleUser === tailscaleUser &&
        device.expiresAt > now &&
        device.revokedAt === undefined,
    );
  }

  enrollDevice(passphrase: string, tailscaleUser: string): string {
    this.requirePassphraseAllowed(tailscaleUser);
    const actual = scryptSync(
      passphrase.normalize("NFKC"),
      Buffer.from(this.state.enrollmentSalt, "base64url"),
      32,
    );
    const expected = Buffer.from(this.state.enrollmentVerifier, "base64url");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      this.recordPassphraseFailure(tailscaleUser);
      throw new ConnectorAuthError("invalid_enrollment_passphrase");
    }
    this.failedPassphrases.delete(tailscaleUser);
    const token = `acd_${randomBytes(32).toString("base64url")}`;
    const now = this.now();
    this.state.devices.push({
      id: `device_${randomBytes(12).toString("base64url")}`,
      tokenHash: sha256(token),
      tailscaleUser,
      createdAt: now,
      expiresAt: now + this.deviceTtlSeconds * 1000,
    });
    this.persist();
    return token;
  }

  approve(requestId: string): { request: PendingAuthorization; code: string } {
    const request = this.getPending(requestId);
    if (!request) throw new ConnectorAuthError("authorization_request_expired");
    this.pending.delete(requestId);
    const code = `acc_${randomBytes(32).toString("base64url")}`;
    const now = this.now();
    this.codes.set(code, {
      value: code,
      request,
      createdAt: now,
      expiresAt: now + CODE_TTL_MS,
    });
    return { request, code };
  }

  deny(requestId: string): PendingAuthorization {
    const request = this.getPending(requestId);
    if (!request) throw new ConnectorAuthError("authorization_request_expired");
    this.pending.delete(requestId);
    return request;
  }

  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    origin: string;
    appId: string;
    redirectUri: string;
  }): { accessToken: string; grant: GrantView } {
    const record = this.codes.get(input.code);
    this.codes.delete(input.code);
    if (!record || record.expiresAt <= this.now()) {
      throw new ConnectorAuthError("invalid_authorization_code");
    }
    const request = record.request;
    if (
      request.origin !== input.origin ||
      request.appId !== input.appId ||
      request.redirectUri !== input.redirectUri ||
      !isPkceVerifier(input.codeVerifier) ||
      sha256Base64Url(input.codeVerifier) !== request.codeChallenge
    ) {
      throw new ConnectorAuthError("invalid_authorization_code");
    }
    const accessToken = `acg_${randomBytes(32).toString("base64url")}`;
    const now = this.now();
    const grant: StoredGrant = {
      id: `grant_${randomBytes(12).toString("base64url")}`,
      tokenHash: sha256(accessToken),
      origin: request.origin,
      appId: request.appId,
      scopes: request.scopes,
      toolHash: request.toolHash,
      toolNames: request.toolNames,
      createdAt: now,
      expiresAt: now + this.grantTtlSeconds * 1000,
    };
    this.state.grants.push(grant);
    this.persist();
    return { accessToken, grant: grantView(grant) };
  }

  verifyGrant(
    token: string,
    expected: {
      origin: string;
      appId: string;
      toolHash: string;
      scopes: readonly string[];
    },
  ): GrantView | undefined {
    const tokenHash = sha256(token);
    const now = this.now();
    const grant = this.state.grants.find(
      (candidate) =>
        candidate.tokenHash === tokenHash &&
        candidate.origin === expected.origin &&
        candidate.appId === expected.appId &&
        candidate.toolHash === expected.toolHash &&
        expected.scopes.every((scope) => candidate.scopes.includes(scope)) &&
        candidate.expiresAt > now &&
        candidate.revokedAt === undefined,
    );
    return grant ? grantView(grant) : undefined;
  }

  isGrantActive(id: string): boolean {
    const now = this.now();
    return this.state.grants.some(
      (grant) =>
        grant.id === id &&
        grant.expiresAt > now &&
        grant.revokedAt === undefined,
    );
  }

  listGrants(): readonly GrantView[] {
    return this.state.grants.map(grantView);
  }

  revokeGrant(id: string): boolean {
    const grant = this.state.grants.find((candidate) => candidate.id === id);
    if (!grant || grant.revokedAt !== undefined) return false;
    grant.revokedAt = this.now();
    this.persist();
    return true;
  }

  revokeGrantByToken(
    token: string,
    expected: { readonly origin: string; readonly appId: string },
  ): boolean {
    const tokenHash = sha256(token);
    const grant = this.state.grants.find(
      (candidate) =>
        candidate.tokenHash === tokenHash &&
        candidate.origin === expected.origin &&
        candidate.appId === expected.appId,
    );
    if (!grant || grant.revokedAt !== undefined) return false;
    grant.revokedAt = this.now();
    this.persist();
    return true;
  }

  private requirePassphraseAllowed(tailscaleUser: string): void {
    const attempt = this.failedPassphrases.get(tailscaleUser);
    if (!attempt) return;
    if (attempt.resetAt <= this.now()) {
      this.failedPassphrases.delete(tailscaleUser);
      return;
    }
    if (attempt.count >= 5) throw new ConnectorAuthError("enrollment_locked");
  }

  private recordPassphraseFailure(tailscaleUser: string): void {
    const current = this.failedPassphrases.get(tailscaleUser);
    const now = this.now();
    if (!current || current.resetAt <= now) {
      this.failedPassphrases.set(tailscaleUser, {
        count: 1,
        resetAt: now + 15 * 60 * 1000,
      });
      return;
    }
    current.count += 1;
  }

  private persist(): void {
    persistState(this.statePath, this.state);
  }
}

export class ConnectorAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function challengePayload(card: RuntimeCard, nonce: string): string {
  return JSON.stringify({
    version: card.version,
    runtimeId: card.runtimeId,
    endpoint: card.endpoint,
    nonce,
  });
}

export function authorizationRedirect(
  request: PendingAuthorization,
  result: { code?: string; error?: string },
): string {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("state", request.state);
  if (result.code) redirect.searchParams.set("code", result.code);
  if (result.error) redirect.searchParams.set("error", result.error);
  return redirect.toString();
}

function createState(passphrase: string): StoredConnectorState {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const connectorPrivateKey = privateKey.export({ format: "jwk" });
  const connectorPublicKey = publicKey.export({ format: "jwk" });
  const runtimeId = `sha256:${sha256(JSON.stringify(connectorPublicKey))}`;
  const salt = randomBytes(16);
  return {
    version: 1,
    runtimeId,
    connectorPrivateKey,
    connectorPublicKey,
    enrollmentSalt: salt.toString("base64url"),
    enrollmentVerifier: scryptSync(
      passphrase.normalize("NFKC"),
      salt,
      32,
    ).toString("base64url"),
    capabilitySigningSecret: randomBytes(32).toString("base64url"),
    grants: [],
    devices: [],
  };
}

function makeRuntimeCard(
  state: StoredConnectorState,
  options: ConnectorAuthOptions,
): RuntimeCard {
  const endpoint = options.publicEndpoint.replace(/\/$/, "");
  return {
    version: 1,
    runtimeId: state.runtimeId,
    endpoint,
    connectorPublicKey: state.connectorPublicKey,
    transportProfile: options.transportProfile ?? "tailscale-serve",
    authorizationServer: endpoint,
  };
}

function createEnrollmentPassphrase(): string {
  const encoded = randomBytes(18).toString("base64url").toUpperCase();
  return `AC-ENROLL-${encoded.match(/.{1,4}/g)?.join("-") ?? encoded}`;
}

function loadState(path: string): StoredConnectorState | undefined {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8"),
    ) as StoredConnectorState;
    if (
      value.version !== 1 ||
      typeof value.runtimeId !== "string" ||
      typeof value.capabilitySigningSecret !== "string" ||
      !Array.isArray(value.grants) ||
      !Array.isArray(value.devices)
    ) {
      throw new Error("unsupported connector state");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function persistState(path: string, state: StoredConnectorState): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function grantView(grant: StoredGrant): GrantView {
  return {
    id: grant.id,
    origin: grant.origin,
    appId: grant.appId,
    scopes: grant.scopes,
    toolHash: grant.toolHash,
    toolNames: grant.toolNames,
    createdAt: new Date(grant.createdAt).toISOString(),
    expiresAt: new Date(grant.expiresAt).toISOString(),
    ...(grant.revokedAt
      ? { revokedAt: new Date(grant.revokedAt).toISOString() }
      : {}),
  };
}

function requireAppId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new ConnectorAuthError("invalid_app_id");
  }
}

function requireRedirect(redirectUri: string, origin: string): void {
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw new ConnectorAuthError("invalid_redirect_uri");
  }
  if (
    redirect.origin !== origin ||
    redirect.protocol !== "https:" ||
    redirect.username ||
    redirect.password ||
    redirect.hash
  ) {
    throw new ConnectorAuthError("invalid_redirect_uri");
  }
}

function isBase64Url(value: string, minimum: number, maximum: number): boolean {
  return (
    value.length >= minimum &&
    value.length <= maximum &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isPkceVerifier(value: string): boolean {
  return (
    value.length >= 43 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._~-]+$/.test(value)
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function sha256Base64Url(value: string): string {
  return sha256(value);
}
