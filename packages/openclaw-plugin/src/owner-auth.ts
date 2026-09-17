import {
  createHash,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_OWNER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface OwnerAuthOptions {
  readonly statePath: string;
  readonly enrollmentPassphrase?: string;
  readonly ownerSessionTtlSeconds?: number;
  readonly now?: () => number;
  readonly onEnrollmentPassphrase?: (passphrase: string) => void;
}

interface StoredOwnerSession {
  readonly id: string;
  readonly tokenHash: string;
  readonly ownerSubject: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  revokedAt?: number;
}

interface StoredOwnerAuthState {
  readonly kind: "agent-connect-owner-auth";
  readonly version: 1;
  readonly enrollmentSalt: string;
  readonly enrollmentVerifier: string;
  ownerSessions: StoredOwnerSession[];
}

interface PreviousCombinedState {
  readonly version: 2;
  readonly enrollmentSalt: string;
  readonly enrollmentVerifier: string;
  readonly ownerSessions: StoredOwnerSession[];
}

const MAX_PASSPHRASE_FAILURES = 256;
const MAX_CONCURRENT_PASSPHRASE_VERIFICATIONS = 2;
const MAX_OWNER_SESSIONS = 256;
const PASSPHRASE_FAILURE_TTL_MS = 15 * 60 * 1000;

export class OwnerAuth {
  private readonly statePath: string;
  private readonly now: () => number;
  private readonly ownerSessionTtlSeconds: number;
  private readonly failedPassphrases = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private activePassphraseVerifications = 0;
  private state: StoredOwnerAuthState;

  constructor(options: OwnerAuthOptions) {
    this.statePath = options.statePath;
    this.now = options.now ?? Date.now;
    this.ownerSessionTtlSeconds =
      options.ownerSessionTtlSeconds ?? DEFAULT_OWNER_SESSION_TTL_SECONDS;
    const loaded = loadState(options.statePath);
    if (loaded) {
      this.state = loaded.state;
      if (loaded.migrated) this.persist();
      return;
    }
    const passphrase =
      options.enrollmentPassphrase ?? createEnrollmentPassphrase();
    this.state = createState(passphrase);
    this.persist();
    options.onEnrollmentPassphrase?.(passphrase);
  }

  isOwnerSession(token: string | undefined, ownerSubject: string): boolean {
    if (token?.startsWith("aco_") !== true) return false;
    const tokenHash = sha256(token);
    const now = this.now();
    return this.state.ownerSessions.some(
      (session) =>
        session.tokenHash === tokenHash &&
        session.ownerSubject === ownerSubject &&
        session.expiresAt > now &&
        session.revokedAt === undefined,
    );
  }

  revokeOwnerSession(token: string | undefined, ownerSubject: string): boolean {
    if (token?.startsWith("aco_") !== true) return false;
    const tokenHash = sha256(token);
    const now = this.now();
    const session = this.state.ownerSessions.find(
      (candidate) =>
        candidate.tokenHash === tokenHash &&
        candidate.ownerSubject === ownerSubject &&
        candidate.expiresAt > now &&
        candidate.revokedAt === undefined,
    );
    if (!session) return false;
    session.revokedAt = now;
    this.persist();
    return true;
  }

  async enrollOwnerSession(
    passphrase: string,
    ownerSubject: string,
  ): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(ownerSubject)) {
      throw new OwnerAuthError("invalid_owner_subject");
    }
    this.pruneFailures();
    this.requirePassphraseAllowed(ownerSubject);
    if (
      this.activePassphraseVerifications >=
      MAX_CONCURRENT_PASSPHRASE_VERIFICATIONS
    ) {
      throw new OwnerAuthError("enrollment_busy");
    }
    await this.verifyPassphrase(passphrase, ownerSubject);
    const now = this.now();
    this.state.ownerSessions = this.state.ownerSessions.filter(
      (session) => session.expiresAt > now && session.revokedAt === undefined,
    );
    if (this.state.ownerSessions.length >= MAX_OWNER_SESSIONS) {
      throw new OwnerAuthError("enrollment_capacity");
    }
    const token = `aco_${randomBytes(32).toString("base64url")}`;
    this.state.ownerSessions.push({
      id: `owner_${randomBytes(12).toString("base64url")}`,
      tokenHash: sha256(token),
      ownerSubject,
      createdAt: now,
      expiresAt: now + this.ownerSessionTtlSeconds * 1000,
    });
    this.persist();
    return token;
  }

  private requirePassphraseAllowed(ownerSubject: string): void {
    const attempt = this.failedPassphrases.get(ownerSubject);
    if (attempt && attempt.count >= 5) {
      throw new OwnerAuthError("enrollment_locked");
    }
  }

  private async verifyPassphrase(
    passphrase: string,
    ownerSubject: string,
  ): Promise<void> {
    this.activePassphraseVerifications += 1;
    let actual: Buffer;
    try {
      actual = await deriveEnrollmentVerifier(
        passphrase,
        Buffer.from(this.state.enrollmentSalt, "base64url"),
      );
    } finally {
      this.activePassphraseVerifications -= 1;
    }
    const expected = Buffer.from(this.state.enrollmentVerifier, "base64url");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      this.recordPassphraseFailure(ownerSubject);
      throw new OwnerAuthError("invalid_enrollment_passphrase");
    }
    this.failedPassphrases.delete(ownerSubject);
  }

  private recordPassphraseFailure(ownerSubject: string): void {
    const now = this.now();
    const current = this.failedPassphrases.get(ownerSubject);
    if (!current || current.resetAt <= now) {
      if (this.failedPassphrases.size >= MAX_PASSPHRASE_FAILURES) {
        throw new OwnerAuthError("enrollment_capacity");
      }
      this.failedPassphrases.set(ownerSubject, {
        count: 1,
        resetAt: now + PASSPHRASE_FAILURE_TTL_MS,
      });
      return;
    }
    current.count += 1;
  }

  private pruneFailures(): void {
    const now = this.now();
    for (const [ownerSubject, failure] of this.failedPassphrases) {
      if (failure.resetAt <= now) this.failedPassphrases.delete(ownerSubject);
    }
  }

  private persist(): void {
    persistState(this.statePath, this.state);
  }
}

export class OwnerAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function createState(passphrase: string): StoredOwnerAuthState {
  const salt = randomBytes(16);
  return {
    kind: "agent-connect-owner-auth",
    version: 1,
    enrollmentSalt: salt.toString("base64url"),
    enrollmentVerifier: scryptSync(
      passphrase.normalize("NFKC"),
      salt,
      32,
    ).toString("base64url"),
    ownerSessions: [],
  };
}

function createEnrollmentPassphrase(): string {
  const encoded = randomBytes(18).toString("base64url").toUpperCase();
  return `AC-ENROLL-${encoded.match(/.{1,4}/g)?.join("-") ?? encoded}`;
}

function loadState(
  path: string,
):
  | { readonly state: StoredOwnerAuthState; readonly migrated: boolean }
  | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isOwnerAuthState(value)) return { state: value, migrated: false };
    if (isPreviousCombinedState(value)) {
      return {
        state: {
          kind: "agent-connect-owner-auth",
          version: 1,
          enrollmentSalt: value.enrollmentSalt,
          enrollmentVerifier: value.enrollmentVerifier,
          ownerSessions: value.ownerSessions,
        },
        migrated: true,
      };
    }
    throw new Error("unsupported owner authentication state");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isOwnerAuthState(value: unknown): value is StoredOwnerAuthState {
  if (!isStateRecord(value)) return false;
  return (
    value.kind === "agent-connect-owner-auth" &&
    value.version === 1 &&
    validSessions(value.ownerSessions)
  );
}

function isPreviousCombinedState(
  value: unknown,
): value is PreviousCombinedState {
  if (!isStateRecord(value)) return false;
  return value.version === 2 && validSessions(value.ownerSessions);
}

function isStateRecord(value: unknown): value is Record<string, unknown> & {
  enrollmentSalt: string;
  enrollmentVerifier: string;
  ownerSessions: StoredOwnerSession[];
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["enrollmentSalt"] === "string" &&
    typeof (value as Record<string, unknown>)["enrollmentVerifier"] ===
      "string" &&
    Array.isArray((value as Record<string, unknown>)["ownerSessions"])
  );
}

function validSessions(value: StoredOwnerSession[]): boolean {
  return value.every(
    (session) =>
      typeof session === "object" &&
      session !== null &&
      typeof session.id === "string" &&
      session.id.startsWith("owner_") &&
      typeof session.tokenHash === "string" &&
      typeof session.ownerSubject === "string" &&
      typeof session.createdAt === "number" &&
      typeof session.expiresAt === "number" &&
      (session.revokedAt === undefined ||
        typeof session.revokedAt === "number"),
  );
}

function persistState(path: string, state: StoredOwnerAuthState): void {
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

function deriveEnrollmentVerifier(
  passphrase: string,
  salt: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize("NFKC"), salt, 32, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
