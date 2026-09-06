import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  hashToolSnapshot,
  validateToolSnapshot,
  type GatewayToolDefinition,
} from "./tool-snapshot.js";

const REQUEST_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 2 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PENDING_REQUESTS = 256;
const MAX_AUTHORIZATION_CODES = 256;
const MAX_SPENT_REFRESH_TOKEN_HASHES = 256;

export type DelegatedNativeCapability =
  "public_web_search" | "sandbox_code_execution";

export interface OfferedDelegatedPolicy {
  readonly ref: string;
  readonly label: string;
  readonly description?: string;
  readonly agentId: string;
  /**
   * Computed by the trusted host integration over everything that can affect
   * the selected agent's native authority. A changed fingerprint invalidates
   * existing grants; it never expands them in place.
   */
  readonly fingerprint: string;
  readonly nativeCapabilities: readonly DelegatedNativeCapability[];
}

export interface DelegatedGrantStore {
  load(): unknown | undefined;
  /**
   * Must return only after committing the value. Ordinary failures must throw
   * before commit. A failure whose commit status is uncertain must throw
   * DelegatedGrantPersistenceUncertainError so the service stops serving from
   * stale memory until it is reconstructed.
   */
  save(value: unknown): void;
}

export interface DelegatedGrantServiceOptions {
  readonly resource: string;
  readonly offeredPolicies: readonly OfferedDelegatedPolicy[];
  readonly statePath?: string;
  readonly store?: DelegatedGrantStore;
  readonly requestTtlSeconds?: number;
  readonly codeTtlSeconds?: number;
  readonly accessTokenTtlSeconds?: number;
  readonly grantTtlSeconds?: number;
  readonly now?: () => number;
}

export interface DelegatedGrantRequestInput {
  /** Version-zero public client identity: its canonical HTTPS origin. */
  readonly clientId: string;
  readonly redirectUri: string;
  /** Must exactly equal the operator-configured resource endpoint. */
  readonly resource: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
  readonly applicationTools: unknown;
}

export interface ApprovedApplicationTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface PendingDelegatedGrantRequest {
  readonly requestUri: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
  readonly applicationTools: readonly ApprovedApplicationTool[];
  readonly toolHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface TrustedOwnerApproval {
  /** Supplied only by the host's verified owner-authentication integration. */
  readonly ownerSubject: string;
  /** Selected from the server-offered policy list, never from app input. */
  readonly policyRef: string;
}

export interface DelegatedGrantView {
  readonly grantId: string;
  readonly subject: string;
  readonly ownerSubject: string;
  readonly clientId: string;
  readonly resource: string;
  readonly agentId: string;
  readonly policyRef: string;
  readonly policyFingerprint: string;
  readonly nativeCapabilities: readonly DelegatedNativeCapability[];
  readonly applicationTools: readonly ApprovedApplicationTool[];
  readonly toolHash: string;
  readonly createdAt: string;
  readonly grantExpiresAt: string;
  readonly revokedAt?: string;
}

export interface ApprovedDelegatedGrant {
  readonly request: PendingDelegatedGrantRequest;
  readonly code: string;
  readonly grant: DelegatedGrantView;
}

export interface DelegatedTokenResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: "Bearer";
  readonly expiresIn: number;
  readonly refreshTokenExpiresIn: number;
  readonly grant: DelegatedGrantView;
}

export interface VerifiedDelegatedGrant extends DelegatedGrantView {
  /** Opaque, non-secret value used to recheck this exact authorization. */
  readonly authorizationVersion: string;
  /** Changes whenever the access credential rotates. */
  readonly accessTokenVersion: string;
  readonly accessTokenExpiresAt: string;
}

interface StoredDelegatedGrant {
  grantId: string;
  authorizationVersion: string;
  ownerSubject: string;
  clientId: string;
  resource: string;
  agentId: string;
  policyRef: string;
  policyFingerprint: string;
  nativeCapabilities: DelegatedNativeCapability[];
  applicationTools: ApprovedApplicationTool[];
  toolHash: string;
  createdAt: number;
  grantExpiresAt: number;
  accessTokenHash?: string;
  accessTokenVersion?: string;
  accessTokenExpiresAt?: number;
  refreshTokenHash?: string;
  spentRefreshTokenHashes: string[];
  revokedAt?: number;
}

interface StoredDelegatedGrantState {
  version: 1;
  grants: StoredDelegatedGrant[];
}

interface AuthorizationCodeRecord {
  readonly request: PendingDelegatedGrantRequest;
  readonly grantId: string;
  readonly expiresAt: number;
}

interface NormalizedPolicy {
  readonly ref: string;
  readonly label: string;
  readonly description?: string;
  readonly agentId: string;
  readonly fingerprint: string;
  readonly nativeCapabilities: readonly DelegatedNativeCapability[];
}

export class DelegatedGrantService {
  readonly resource: string;

  private readonly store: DelegatedGrantStore;
  private readonly policies: ReadonlyMap<string, NormalizedPolicy>;
  private readonly now: () => number;
  private readonly requestTtlMs: number;
  private readonly codeTtlMs: number;
  private readonly accessTokenTtlMs: number;
  private readonly grantTtlMs: number;
  private state: StoredDelegatedGrantState;
  private readonly pending = new Map<string, PendingDelegatedGrantRequest>();
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly exchangingCodes = new Set<string>();
  private readonly refreshingTokens = new Set<string>();
  private persistenceUncertain = false;

  constructor(options: DelegatedGrantServiceOptions) {
    this.resource = requireCanonicalHttpsUrl(
      options.resource,
      "invalid_resource",
    );
    if ((options.statePath === undefined) === (options.store === undefined)) {
      throw new DelegatedGrantError("invalid_configuration");
    }
    this.store =
      options.store ?? new FileDelegatedGrantStore(options.statePath as string);
    this.policies = normalizePolicies(options.offeredPolicies);
    this.now = options.now ?? Date.now;
    this.requestTtlMs = ttlMs(options.requestTtlSeconds, REQUEST_TTL_MS);
    this.codeTtlMs = ttlMs(options.codeTtlSeconds, CODE_TTL_MS);
    this.accessTokenTtlMs = ttlMs(options.accessTokenTtlSeconds, ACCESS_TTL_MS);
    this.grantTtlMs = ttlMs(options.grantTtlSeconds, GRANT_TTL_MS);

    const loaded = this.store.load();
    if (loaded === undefined) {
      this.state = { version: 1, grants: [] };
      this.store.save(this.state);
    } else {
      this.state = parseState(loaded);
    }
  }

  createRequest(
    input: DelegatedGrantRequestInput,
  ): PendingDelegatedGrantRequest {
    this.requirePersistenceAvailable();
    this.pruneTransientState();
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new DelegatedGrantError("authorization_capacity");
    }
    const clientId = requireCanonicalClientId(input.clientId);
    const redirectUri = requireRedirectUri(input.redirectUri, clientId);
    const resource = requireCanonicalHttpsUrl(
      input.resource,
      "invalid_resource",
    );
    if (resource !== this.resource) {
      throw new DelegatedGrantError("invalid_resource");
    }
    if (input.codeChallengeMethod !== "S256") {
      throw new DelegatedGrantError("invalid_code_challenge_method");
    }
    if (!isBase64Url(input.codeChallenge, 43, 43)) {
      throw new DelegatedGrantError("invalid_code_challenge");
    }
    if (
      input.state.length === 0 ||
      input.state.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(input.state)
    ) {
      throw new DelegatedGrantError("invalid_state");
    }
    const { tools, toolHash } = normalizeApplicationTools(
      input.applicationTools,
    );
    const now = this.now();
    const request: PendingDelegatedGrantRequest = {
      requestUri: `urn:ietf:params:oauth:request_uri:ac_request_${randomBytes(18).toString("base64url")}`,
      clientId,
      redirectUri,
      resource,
      state: input.state,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: "S256",
      applicationTools: tools,
      toolHash,
      createdAt: now,
      expiresAt: now + this.requestTtlMs,
    };
    this.pending.set(request.requestUri, request);
    return cloneJson(request);
  }

  getRequest(requestUri: string): PendingDelegatedGrantRequest | undefined {
    this.requirePersistenceAvailable();
    this.pruneTransientState();
    const request = this.pending.get(requestUri);
    return request ? cloneJson(request) : undefined;
  }

  deny(requestUri: string): PendingDelegatedGrantRequest {
    this.requirePersistenceAvailable();
    const request = this.getRequest(requestUri);
    if (!request) {
      throw new DelegatedGrantError("authorization_request_expired");
    }
    this.pending.delete(requestUri);
    return request;
  }

  listOfferedPolicies(): readonly {
    readonly ref: string;
    readonly label: string;
    readonly description?: string;
    readonly agentId: string;
    readonly nativeCapabilities: readonly DelegatedNativeCapability[];
  }[] {
    this.requirePersistenceAvailable();
    return [...this.policies.values()].map((policy) => ({
      ref: policy.ref,
      label: policy.label,
      ...(policy.description === undefined
        ? {}
        : { description: policy.description }),
      agentId: policy.agentId,
      nativeCapabilities: [...policy.nativeCapabilities],
    }));
  }

  approve(
    requestUri: string,
    approval: TrustedOwnerApproval,
  ): ApprovedDelegatedGrant {
    this.requirePersistenceAvailable();
    this.pruneTransientState();
    const request = this.pending.get(requestUri);
    if (!request) {
      throw new DelegatedGrantError("authorization_request_expired");
    }
    if (this.codes.size >= MAX_AUTHORIZATION_CODES) {
      throw new DelegatedGrantError("authorization_capacity");
    }
    requireBoundedIdentity(approval.ownerSubject, "invalid_owner_subject");
    const policy = this.policies.get(approval.policyRef);
    if (!policy) throw new DelegatedGrantError("invalid_policy");

    const now = this.now();
    const grant: StoredDelegatedGrant = {
      grantId: `ac_grant_${randomBytes(18).toString("base64url")}`,
      authorizationVersion: randomBytes(18).toString("base64url"),
      ownerSubject: approval.ownerSubject,
      clientId: request.clientId,
      resource: request.resource,
      agentId: policy.agentId,
      policyRef: policy.ref,
      policyFingerprint: policy.fingerprint,
      nativeCapabilities: [...policy.nativeCapabilities],
      applicationTools: [...cloneJson(request.applicationTools)],
      toolHash: request.toolHash,
      createdAt: now,
      grantExpiresAt: now + this.grantTtlMs,
      spentRefreshTokenHashes: [],
    };
    const code = `ac_code_${randomBytes(32).toString("base64url")}`;
    const next = cloneState(this.state);
    next.grants.push(grant);
    this.commit(next);

    this.pending.delete(requestUri);
    this.codes.set(code, {
      request,
      grantId: grant.grantId,
      expiresAt: now + this.codeTtlMs,
    });
    return {
      request: cloneJson(request),
      code,
      grant: grantView(grant),
    };
  }

  exchange(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly resource: string;
  }): DelegatedTokenResult {
    this.requirePersistenceAvailable();
    this.pruneTransientState();
    const record = this.codes.get(input.code);
    if (
      !record ||
      record.expiresAt <= this.now() ||
      this.exchangingCodes.has(input.code)
    ) {
      throw new DelegatedGrantError("invalid_authorization_code");
    }
    this.exchangingCodes.add(input.code);
    try {
      if (!this.matchesCodeExchange(record.request, input)) {
        this.codes.delete(input.code);
        throw new DelegatedGrantError("invalid_authorization_code");
      }
      const grant = this.findActiveGrant(record.grantId);
      if (!grant || !this.policyIsCurrent(grant)) {
        this.codes.delete(input.code);
        throw new DelegatedGrantError("invalid_authorization_code");
      }
      const result = this.issueTokens(grant);
      this.codes.delete(input.code);
      return result;
    } finally {
      this.exchangingCodes.delete(input.code);
    }
  }

  refresh(input: {
    readonly refreshToken: string;
    readonly clientId: string;
    readonly resource: string;
  }): DelegatedTokenResult {
    this.requirePersistenceAvailable();
    const clientId = requireCanonicalClientId(input.clientId);
    const resource = requireCanonicalHttpsUrl(
      input.resource,
      "invalid_resource",
    );
    if (
      resource !== this.resource ||
      !input.refreshToken.startsWith("ac_refresh_")
    ) {
      throw new DelegatedGrantError("invalid_refresh_token");
    }
    const tokenHash = sha256(input.refreshToken);
    if (this.refreshingTokens.has(tokenHash)) {
      throw new DelegatedGrantError("invalid_refresh_token");
    }
    this.refreshingTokens.add(tokenHash);
    try {
      const now = this.now();
      const grant = this.state.grants.find(
        (candidate) =>
          candidate.refreshTokenHash !== undefined &&
          equalHash(candidate.refreshTokenHash, tokenHash) &&
          candidate.clientId === clientId &&
          candidate.resource === resource,
      );
      if (!grant) {
        const replayedGrant = this.state.grants.find(
          (candidate) =>
            candidate.clientId === clientId &&
            candidate.resource === resource &&
            candidate.spentRefreshTokenHashes.some((spentHash) =>
              equalHash(spentHash, tokenHash),
            ),
        );
        if (replayedGrant && isActive(replayedGrant, now)) {
          this.commitRevocation(replayedGrant);
          throw new DelegatedGrantError("refresh_token_reuse");
        }
        throw new DelegatedGrantError("invalid_refresh_token");
      }
      if (!isActive(grant, now)) {
        throw new DelegatedGrantError("invalid_refresh_token");
      }
      if (!this.policyIsCurrent(grant)) {
        throw new DelegatedGrantError("policy_changed");
      }
      return this.issueTokens(grant);
    } finally {
      this.refreshingTokens.delete(tokenHash);
    }
  }

  verify(
    accessToken: string,
    expected: { readonly resource: string; readonly origin?: string },
  ): VerifiedDelegatedGrant | undefined {
    if (this.persistenceUncertain) return undefined;
    if (!accessToken.startsWith("ac_access_")) return undefined;
    let resource: string;
    try {
      resource = requireCanonicalHttpsUrl(
        expected.resource,
        "invalid_resource",
      );
    } catch {
      return undefined;
    }
    if (resource !== this.resource) return undefined;
    const tokenHash = sha256(accessToken);
    const now = this.now();
    const grant = this.state.grants.find(
      (candidate) =>
        candidate.accessTokenHash !== undefined &&
        equalHash(candidate.accessTokenHash, tokenHash) &&
        candidate.resource === resource,
    );
    if (
      !grant ||
      !isActive(grant, now) ||
      grant.accessTokenExpiresAt === undefined ||
      grant.accessTokenExpiresAt <= now ||
      !this.policyIsCurrent(grant)
    ) {
      return undefined;
    }
    if (expected.origin !== undefined) {
      try {
        if (requireCanonicalClientId(expected.origin) !== grant.clientId) {
          return undefined;
        }
      } catch {
        return undefined;
      }
    }
    return verifiedGrant(grant);
  }

  /** Rechecks revocation/config expiry immediately before provider effects. */
  recheck(
    verification: VerifiedDelegatedGrant,
    expected?: { readonly applicationTools: unknown },
  ): boolean {
    if (this.persistenceUncertain) return false;
    const grant = this.state.grants.find(
      (candidate) => candidate.grantId === verification.grantId,
    );
    if (
      !grant ||
      !isActive(grant, this.now()) ||
      !this.policyIsCurrent(grant) ||
      grant.authorizationVersion !== verification.authorizationVersion ||
      grant.accessTokenVersion !== verification.accessTokenVersion ||
      grant.accessTokenExpiresAt === undefined ||
      grant.accessTokenExpiresAt <= this.now() ||
      new Date(grant.accessTokenExpiresAt).toISOString() !==
        verification.accessTokenExpiresAt ||
      verification.subject !== `agent-connect:grant:${grant.grantId}` ||
      grant.ownerSubject !== verification.ownerSubject ||
      grant.clientId !== verification.clientId ||
      grant.resource !== verification.resource ||
      grant.agentId !== verification.agentId ||
      grant.policyRef !== verification.policyRef ||
      grant.policyFingerprint !== verification.policyFingerprint ||
      !arraysEqual(grant.nativeCapabilities, verification.nativeCapabilities) ||
      grant.toolHash !== verification.toolHash
    ) {
      return false;
    }
    if (expected) {
      try {
        return (
          normalizeApplicationTools(expected.applicationTools).toolHash ===
          grant.toolHash
        );
      } catch {
        return false;
      }
    }
    return true;
  }

  /** Trusted owner/operator revocation by durable grant id. */
  revoke(grantId: string): boolean {
    this.requirePersistenceAvailable();
    const grant = this.state.grants.find(
      (candidate) => candidate.grantId === grantId,
    );
    if (!grant || grant.revokedAt !== undefined) return false;
    return this.commitRevocation(grant);
  }

  /** Public-client revocation by possession, without accepting a grant id. */
  revokeByToken(token: string, clientId: string): boolean {
    this.requirePersistenceAvailable();
    let normalizedClientId: string;
    try {
      normalizedClientId = requireCanonicalClientId(clientId);
    } catch {
      return false;
    }
    if (!token.startsWith("ac_access_") && !token.startsWith("ac_refresh_")) {
      return false;
    }
    const tokenHash = sha256(token);
    const grant = this.state.grants.find(
      (candidate) =>
        candidate.clientId === normalizedClientId &&
        ((candidate.accessTokenHash !== undefined &&
          equalHash(candidate.accessTokenHash, tokenHash)) ||
          (candidate.refreshTokenHash !== undefined &&
            equalHash(candidate.refreshTokenHash, tokenHash))),
    );
    if (!grant || grant.revokedAt !== undefined) return false;
    return this.commitRevocation(grant);
  }

  private matchesCodeExchange(
    request: PendingDelegatedGrantRequest,
    input: {
      readonly codeVerifier: string;
      readonly clientId: string;
      readonly redirectUri: string;
      readonly resource: string;
    },
  ): boolean {
    try {
      const clientId = requireCanonicalClientId(input.clientId);
      return (
        clientId === request.clientId &&
        requireRedirectUri(input.redirectUri, clientId) ===
          request.redirectUri &&
        requireCanonicalHttpsUrl(input.resource, "invalid_resource") ===
          request.resource &&
        isPkceVerifier(input.codeVerifier) &&
        sha256(input.codeVerifier) === request.codeChallenge
      );
    } catch {
      return false;
    }
  }

  private issueTokens(grant: StoredDelegatedGrant): DelegatedTokenResult {
    const now = this.now();
    if (!isActive(grant, now)) {
      throw new DelegatedGrantError("grant_inactive");
    }
    const accessToken = `ac_access_${randomBytes(32).toString("base64url")}`;
    const refreshToken = `ac_refresh_${randomBytes(32).toString("base64url")}`;
    const accessTokenExpiresAt = Math.min(
      now + this.accessTokenTtlMs,
      grant.grantExpiresAt,
    );
    const next = cloneState(this.state);
    const nextGrant = next.grants.find(
      (candidate) =>
        candidate.grantId === grant.grantId &&
        candidate.authorizationVersion === grant.authorizationVersion,
    );
    if (!nextGrant || !isActive(nextGrant, now)) {
      throw new DelegatedGrantError("grant_inactive");
    }
    nextGrant.accessTokenHash = sha256(accessToken);
    nextGrant.accessTokenVersion = randomBytes(18).toString("base64url");
    nextGrant.accessTokenExpiresAt = accessTokenExpiresAt;
    if (nextGrant.refreshTokenHash !== undefined) {
      nextGrant.spentRefreshTokenHashes.push(nextGrant.refreshTokenHash);
      if (
        nextGrant.spentRefreshTokenHashes.length >
        MAX_SPENT_REFRESH_TOKEN_HASHES
      ) {
        nextGrant.spentRefreshTokenHashes.splice(
          0,
          nextGrant.spentRefreshTokenHashes.length -
            MAX_SPENT_REFRESH_TOKEN_HASHES,
        );
      }
    }
    nextGrant.refreshTokenHash = sha256(refreshToken);
    this.commit(next);
    return {
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      expiresIn: secondsUntil(accessTokenExpiresAt, now),
      refreshTokenExpiresIn: secondsUntil(grant.grantExpiresAt, now),
      grant: grantView(nextGrant),
    };
  }

  private findActiveGrant(grantId: string): StoredDelegatedGrant | undefined {
    const now = this.now();
    return this.state.grants.find(
      (candidate) => candidate.grantId === grantId && isActive(candidate, now),
    );
  }

  private policyIsCurrent(grant: StoredDelegatedGrant): boolean {
    const policy = this.policies.get(grant.policyRef);
    return (
      policy !== undefined &&
      policy.agentId === grant.agentId &&
      policy.fingerprint === grant.policyFingerprint &&
      arraysEqual(policy.nativeCapabilities, grant.nativeCapabilities)
    );
  }

  private commitRevocation(grant: StoredDelegatedGrant): boolean {
    const next = cloneState(this.state);
    const nextGrant = next.grants.find(
      (candidate) =>
        candidate.grantId === grant.grantId &&
        candidate.authorizationVersion === grant.authorizationVersion,
    );
    if (!nextGrant || nextGrant.revokedAt !== undefined) return false;
    nextGrant.revokedAt = this.now();
    delete nextGrant.accessTokenHash;
    delete nextGrant.accessTokenVersion;
    delete nextGrant.accessTokenExpiresAt;
    delete nextGrant.refreshTokenHash;
    this.commit(next);
    return true;
  }

  private commit(next: StoredDelegatedGrantState): void {
    try {
      this.store.save(next);
    } catch (error) {
      if (error instanceof DelegatedGrantPersistenceUncertainError) {
        this.persistenceUncertain = true;
      }
      throw error;
    }
    this.state = next;
  }

  private requirePersistenceAvailable(): void {
    if (this.persistenceUncertain) {
      throw new DelegatedGrantError("persistence_reload_required");
    }
  }

  private pruneTransientState(): void {
    const now = this.now();
    for (const [id, request] of this.pending) {
      if (request.expiresAt <= now) this.pending.delete(id);
    }
    for (const [code, record] of this.codes) {
      if (record.expiresAt <= now) this.codes.delete(code);
    }
  }
}

export class DelegatedGrantError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

class FileDelegatedGrantStore implements DelegatedGrantStore {
  constructor(private readonly path: string) {}

  load(): unknown | undefined {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  save(value: unknown): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    let renamed = false;
    try {
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, this.path);
      renamed = true;
      try {
        let directoryDescriptor: number | undefined;
        try {
          directoryDescriptor = openSync(directory, "r");
          fsyncSync(directoryDescriptor);
        } finally {
          if (directoryDescriptor !== undefined) {
            closeSync(directoryDescriptor);
          }
        }
      } catch (error) {
        throw new DelegatedGrantPersistenceUncertainError(error);
      }
    } finally {
      if (!renamed) {
        try {
          unlinkSync(temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }
}

export class DelegatedGrantPersistenceUncertainError extends Error {
  constructor(readonly cause: unknown) {
    super("delegated grant persistence commit requires reload");
  }
}

function normalizePolicies(
  offered: readonly OfferedDelegatedPolicy[],
): ReadonlyMap<string, NormalizedPolicy> {
  if (offered.length === 0 || offered.length > 64) {
    throw new DelegatedGrantError("invalid_configuration");
  }
  const policies = new Map<string, NormalizedPolicy>();
  for (const candidate of offered) {
    requireBoundedIdentity(candidate.ref, "invalid_configuration");
    requireBoundedIdentity(candidate.label, "invalid_configuration");
    if (candidate.description !== undefined) {
      requireBoundedIdentity(candidate.description, "invalid_configuration");
    }
    requireBoundedIdentity(candidate.agentId, "invalid_configuration");
    requireBoundedIdentity(candidate.fingerprint, "invalid_configuration");
    if (policies.has(candidate.ref)) {
      throw new DelegatedGrantError("invalid_configuration");
    }
    const capabilities = [...candidate.nativeCapabilities].sort();
    if (
      new Set(capabilities).size !== capabilities.length ||
      capabilities.some(
        (capability) =>
          capability !== "public_web_search" &&
          capability !== "sandbox_code_execution",
      )
    ) {
      throw new DelegatedGrantError("invalid_configuration");
    }
    policies.set(candidate.ref, {
      ref: candidate.ref,
      label: candidate.label,
      ...(candidate.description === undefined
        ? {}
        : { description: candidate.description }),
      agentId: candidate.agentId,
      fingerprint: candidate.fingerprint,
      nativeCapabilities: capabilities,
    });
  }
  return policies;
}

function normalizeApplicationTools(value: unknown): {
  tools: ApprovedApplicationTool[];
  toolHash: string;
} {
  if (Array.isArray(value) && value.length === 0) {
    return { tools: [], toolHash: hashToolSnapshot([]) };
  }
  if (
    Array.isArray(value) &&
    value.some(
      (candidate) =>
        isRecord(candidate) &&
        Object.prototype.hasOwnProperty.call(candidate, "strict"),
    )
  ) {
    throw new DelegatedGrantError("invalid_application_tools");
  }
  let jsonValue: unknown;
  try {
    jsonValue = cloneJson(value);
  } catch {
    throw new DelegatedGrantError("invalid_application_tools");
  }
  let validated: GatewayToolDefinition[];
  try {
    validated = validateToolSnapshot(jsonValue);
  } catch {
    throw new DelegatedGrantError("invalid_application_tools");
  }
  return {
    tools: validated,
    toolHash: hashToolSnapshot(validated),
  };
}

function parseState(value: unknown): StoredDelegatedGrantState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.grants)) {
    throw new DelegatedGrantError("invalid_state_file");
  }
  const grantIds = new Set<string>();
  const tokenHashes = new Set<string>();
  for (const grant of value.grants) {
    if (!isStoredGrant(grant) || grantIds.has(grant.grantId)) {
      throw new DelegatedGrantError("invalid_state_file");
    }
    const grantTokenHashes = [
      ...(grant.accessTokenHash === undefined ? [] : [grant.accessTokenHash]),
      ...(grant.refreshTokenHash === undefined ? [] : [grant.refreshTokenHash]),
      ...grant.spentRefreshTokenHashes,
    ];
    if (
      new Set(grantTokenHashes).size !== grantTokenHashes.length ||
      grantTokenHashes.some((hash) => tokenHashes.has(hash))
    ) {
      throw new DelegatedGrantError("invalid_state_file");
    }
    grantIds.add(grant.grantId);
    grantTokenHashes.forEach((hash) => tokenHashes.add(hash));
  }
  return cloneJson(value) as unknown as StoredDelegatedGrantState;
}

function isStoredGrant(value: unknown): value is StoredDelegatedGrant {
  if (!isRecord(value)) return false;
  if (!(
    typeof value.grantId === "string" &&
    value.grantId.startsWith("ac_grant_") &&
    typeof value.authorizationVersion === "string" &&
    typeof value.ownerSubject === "string" &&
    typeof value.clientId === "string" &&
    typeof value.resource === "string" &&
    typeof value.agentId === "string" &&
    typeof value.policyRef === "string" &&
    typeof value.policyFingerprint === "string" &&
    Array.isArray(value.nativeCapabilities) &&
    value.nativeCapabilities.every(
      (capability) =>
        capability === "public_web_search" ||
        capability === "sandbox_code_execution",
    ) &&
    Array.isArray(value.applicationTools) &&
    typeof value.toolHash === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.grantExpiresAt === "number" &&
    (value.accessTokenHash === undefined ||
      typeof value.accessTokenHash === "string") &&
    (value.accessTokenVersion === undefined ||
      typeof value.accessTokenVersion === "string") &&
    (value.accessTokenExpiresAt === undefined ||
      typeof value.accessTokenExpiresAt === "number") &&
    (value.refreshTokenHash === undefined ||
      typeof value.refreshTokenHash === "string") &&
    Array.isArray(value.spentRefreshTokenHashes) &&
    value.spentRefreshTokenHashes.length <= MAX_SPENT_REFRESH_TOKEN_HASHES &&
    value.spentRefreshTokenHashes.every(
      (hash) => typeof hash === "string" && isBase64Url(hash, 43, 43),
    ) &&
    (value.revokedAt === undefined || typeof value.revokedAt === "number")
  )) {
    return false;
  }
  const nativeCapabilities = value.nativeCapabilities;
  if (
    !Number.isFinite(value.createdAt) ||
    !Number.isFinite(value.grantExpiresAt) ||
    value.grantExpiresAt <= value.createdAt ||
    !isBase64Url(value.authorizationVersion, 24, 24) ||
    (value.accessTokenHash !== undefined &&
      !isBase64Url(value.accessTokenHash, 43, 43)) ||
    (value.refreshTokenHash !== undefined &&
      !isBase64Url(value.refreshTokenHash, 43, 43)) ||
    new Set(value.spentRefreshTokenHashes).size !==
      value.spentRefreshTokenHashes.length ||
    (value.accessTokenVersion !== undefined &&
      !isBase64Url(value.accessTokenVersion, 24, 24)) ||
    (value.accessTokenExpiresAt !== undefined &&
      (!Number.isFinite(value.accessTokenExpiresAt) ||
        value.accessTokenExpiresAt > value.grantExpiresAt)) ||
    (value.revokedAt !== undefined && !Number.isFinite(value.revokedAt)) ||
    (value.revokedAt !== undefined &&
      (value.accessTokenHash !== undefined ||
        value.accessTokenVersion !== undefined ||
        value.accessTokenExpiresAt !== undefined ||
        value.refreshTokenHash !== undefined)) ||
    (value.accessTokenHash === undefined) !==
      (value.accessTokenVersion === undefined) ||
    (value.accessTokenHash === undefined) !==
      (value.accessTokenExpiresAt === undefined) ||
    (value.accessTokenHash === undefined) !==
      (value.refreshTokenHash === undefined) ||
    [...nativeCapabilities]
      .sort()
      .some((capability, index) => capability !== nativeCapabilities[index]) ||
    new Set(nativeCapabilities).size !== nativeCapabilities.length
  ) {
    return false;
  }
  try {
    requireBoundedIdentity(value.ownerSubject, "invalid_state_file");
    requireBoundedIdentity(value.agentId, "invalid_state_file");
    requireBoundedIdentity(value.policyRef, "invalid_state_file");
    requireBoundedIdentity(value.policyFingerprint, "invalid_state_file");
    requireCanonicalClientId(value.clientId);
    requireCanonicalHttpsUrl(value.resource, "invalid_state_file");
    const normalized = normalizeApplicationTools(value.applicationTools);
    return normalized.toolHash === value.toolHash;
  } catch {
    return false;
  }
}

function requireCanonicalClientId(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DelegatedGrantError("invalid_client");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    value !== url.origin
  ) {
    throw new DelegatedGrantError("invalid_client");
  }
  return value;
}

function requireRedirectUri(value: string, clientId: string): string {
  const url = requireUrl(value, "invalid_redirect_uri");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.origin !== clientId ||
    url.toString() !== value
  ) {
    throw new DelegatedGrantError("invalid_redirect_uri");
  }
  return value;
}

function requireCanonicalHttpsUrl(value: string, code: string): string {
  const url = requireUrl(value, code);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.toString() !== value
  ) {
    throw new DelegatedGrantError(code);
  }
  return value;
}

function requireUrl(value: string, code: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new DelegatedGrantError(code);
  }
}

function requireBoundedIdentity(value: string, code: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new DelegatedGrantError(code);
  }
}

function isPkceVerifier(value: string): boolean {
  return (
    value.length >= 43 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._~-]+$/.test(value)
  );
}

function isBase64Url(value: string, minimum: number, maximum: number): boolean {
  return (
    value.length >= minimum &&
    value.length <= maximum &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isActive(grant: StoredDelegatedGrant, now: number): boolean {
  return grant.revokedAt === undefined && grant.grantExpiresAt > now;
}

function grantView(grant: StoredDelegatedGrant): DelegatedGrantView {
  return {
    grantId: grant.grantId,
    subject: `agent-connect:grant:${grant.grantId}`,
    ownerSubject: grant.ownerSubject,
    clientId: grant.clientId,
    resource: grant.resource,
    agentId: grant.agentId,
    policyRef: grant.policyRef,
    policyFingerprint: grant.policyFingerprint,
    nativeCapabilities: [...grant.nativeCapabilities],
    applicationTools: cloneJson(grant.applicationTools),
    toolHash: grant.toolHash,
    createdAt: new Date(grant.createdAt).toISOString(),
    grantExpiresAt: new Date(grant.grantExpiresAt).toISOString(),
    ...(grant.revokedAt === undefined
      ? {}
      : { revokedAt: new Date(grant.revokedAt).toISOString() }),
  };
}

function verifiedGrant(grant: StoredDelegatedGrant): VerifiedDelegatedGrant {
  if (
    grant.accessTokenExpiresAt === undefined ||
    grant.accessTokenVersion === undefined
  ) {
    throw new DelegatedGrantError("grant_inactive");
  }
  return {
    ...grantView(grant),
    authorizationVersion: grant.authorizationVersion,
    accessTokenVersion: grant.accessTokenVersion,
    accessTokenExpiresAt: new Date(grant.accessTokenExpiresAt).toISOString(),
  };
}

function ttlMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DelegatedGrantError("invalid_configuration");
  }
  return value * 1000;
}

function secondsUntil(expiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 1000));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function equalHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function cloneState(
  state: StoredDelegatedGrantState,
): StoredDelegatedGrantState {
  return cloneJson(state);
}

function cloneJson<T>(value: T): T {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("value is not JSON serializable");
  return JSON.parse(json) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
