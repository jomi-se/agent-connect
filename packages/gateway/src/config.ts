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
    allowedOrigins: csvSet(env.AGENT_CONNECT_ALLOWED_ORIGINS),
    allowedTailscaleUsers: csvSet(env.AGENT_CONNECT_ALLOWED_TAILSCALE_USERS),
    ...(env.AGENT_CONNECT_ACCESS_TOKEN
      ? { accessToken: env.AGENT_CONNECT_ACCESS_TOKEN }
      : {}),
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
