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
  if (
    parsed["version"] !== 1 ||
    !nonEmptyString(parsed["runtimeId"]) ||
    !absoluteHttpsUrl(parsed["endpoint"]) ||
    !isRecord(publicKey) ||
    !nonEmptyString(parsed["transportProfile"]) ||
    !absoluteHttpsUrl(parsed["authorizationServer"])
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

function absoluteHttpsUrl(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
