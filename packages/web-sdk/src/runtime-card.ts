import type { RuntimeCard } from "./types.js";

export function parseRuntimeCard(value: string): RuntimeCard {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Invalid Agent Connect runtime card");
  }

  if (!isRecord(parsed)) {
    throw new TypeError("Invalid Agent Connect runtime card");
  }
  const publicKey = parsed["connectorPublicKey"];
  const endpoint = httpsOrigin(parsed["endpoint"]);
  const authorizationServer = httpsOrigin(parsed["authorizationServer"]);
  if (
    parsed["version"] !== 1 ||
    !nonEmptyString(parsed["runtimeId"]) ||
    !endpoint ||
    !isRecord(publicKey) ||
    publicKey["kty"] !== "OKP" ||
    publicKey["crv"] !== "Ed25519" ||
    !isEd25519PublicKey(publicKey["x"]) ||
    !nonEmptyString(parsed["transportProfile"]) ||
    !authorizationServer ||
    authorizationServer !== endpoint
  ) {
    throw new TypeError("Invalid Agent Connect runtime card");
  }

  return parsed as unknown as RuntimeCard;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function httpsOrigin(value: unknown): string | undefined {
  if (!nonEmptyString(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== "/" && parsed.pathname !== "") ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function isEd25519PublicKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
