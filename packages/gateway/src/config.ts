import type { GatewayOptions } from "./gateway.js";

export interface GatewayRuntimeConfig extends GatewayOptions {
  readonly host: string;
  readonly port: number;
}

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GatewayRuntimeConfig {
  return {
    host: env.AGENT_CONNECT_HOST ?? "127.0.0.1",
    port: parsePort(env.AGENT_CONNECT_PORT ?? "8787"),
    omnigentBaseUrl: env.OMNIGENT_URL ?? "http://127.0.0.1:6767",
    workspace: env.AGENT_CONNECT_WORKSPACE ?? process.cwd(),
    ...(env.AGENT_CONNECT_OMNIGENT_HOST_ID
      ? { omnigentHostId: env.AGENT_CONNECT_OMNIGENT_HOST_ID }
      : {}),
    allowedOrigins: csvSet(env.AGENT_CONNECT_ALLOWED_ORIGINS),
    allowedTailscaleUsers: csvSet(env.AGENT_CONNECT_ALLOWED_TAILSCALE_USERS),
    ...(env.AGENT_CONNECT_ACCESS_TOKEN
      ? { accessToken: env.AGENT_CONNECT_ACCESS_TOKEN }
      : {}),
    ...(env.AGENT_CONNECT_PAIRING_CODE
      ? { pairingCode: env.AGENT_CONNECT_PAIRING_CODE }
      : {}),
    ...(env.AGENT_CONNECT_SIGNING_SECRET
      ? { capabilitySigningSecret: env.AGENT_CONNECT_SIGNING_SECRET }
      : {}),
    capabilityTtlSeconds: parsePositiveInteger(
      env.AGENT_CONNECT_CAPABILITY_TTL_SECONDS ?? "3600",
      "AGENT_CONNECT_CAPABILITY_TTL_SECONDS",
    ),
    pairingCodeTtlSeconds: parsePositiveInteger(
      env.AGENT_CONNECT_PAIRING_CODE_TTL_SECONDS ?? "600",
      "AGENT_CONNECT_PAIRING_CODE_TTL_SECONDS",
    ),
  };
}

function csvSet(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`Invalid AGENT_CONNECT_PORT: ${value}`);
  }
  return port;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`Invalid ${name}: ${value}`);
  }
  return parsed;
}
