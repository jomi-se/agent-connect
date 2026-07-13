import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface CapabilityClaims {
  readonly version: 1;
  readonly appId: string;
  readonly origin: string;
  readonly sessionId: string;
  readonly toolHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
}

export function createPairingCode(): string {
  const value = randomBytes(6).toString("hex").toUpperCase();
  return `AC-${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
}

export function issueCapability(
  claims: Omit<CapabilityClaims, "version" | "nonce">,
  secret: string,
): string {
  const payload: CapabilityClaims = {
    version: 1,
    ...claims,
    nonce: randomBytes(12).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyCapability(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): CapabilityClaims | undefined {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) return undefined;
  if (!safeEqual(signature, sign(encoded, secret))) return undefined;

  try {
    const claims = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<CapabilityClaims>;
    if (
      claims.version !== 1 ||
      typeof claims.appId !== "string" ||
      typeof claims.origin !== "string" ||
      typeof claims.sessionId !== "string" ||
      typeof claims.toolHash !== "string" ||
      typeof claims.issuedAt !== "number" ||
      typeof claims.expiresAt !== "number" ||
      typeof claims.nonce !== "string" ||
      claims.issuedAt > nowSeconds + 30 ||
      claims.expiresAt <= nowSeconds
    ) {
      return undefined;
    }
    return claims as CapabilityClaims;
  } catch {
    return undefined;
  }
}

export function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
