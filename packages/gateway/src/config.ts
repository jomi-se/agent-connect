import type { GatewayOptions } from "./gateway.js";

export interface GatewayRuntimeConfig extends GatewayOptions {
  readonly host: string;
  readonly port: number;
}

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GatewayRuntimeConfig {
  const sandbox = sandboxFromEnv(env);
  const transportProfile = env.AGENT_CONNECT_TRANSPORT_PROFILE;
  const publicDemoAuthorities =
    transportProfile === "public-demo"
      ? csvValues(
          env.AGENT_CONNECT_PUBLIC_DEMO_REDIRECT_URIS ||
            requiredEnv(env, "AGENT_CONNECT_PUBLIC_DEMO_REDIRECT_URI"),
        ).map((redirectUri) => ({
          appId: requiredEnv(env, "AGENT_CONNECT_PUBLIC_DEMO_APP_ID"),
          redirectUri,
          toolHash: requiredEnv(env, "AGENT_CONNECT_PUBLIC_DEMO_TOOL_HASH"),
        }))
      : undefined;
  return {
    host: env.AGENT_CONNECT_HOST ?? "127.0.0.1",
    port: parsePort(env.AGENT_CONNECT_PORT ?? "8787"),
    omnigentBaseUrl: env.OMNIGENT_URL ?? "http://127.0.0.1:6767",
    workspace: env.AGENT_CONNECT_WORKSPACE ?? process.cwd(),
    ...(env.AGENT_CONNECT_OMNIGENT_HOST_ID
      ? { omnigentHostId: env.AGENT_CONNECT_OMNIGENT_HOST_ID }
      : {}),
    ...(sandbox ? { omnigentSandbox: sandbox } : {}),
    allowedOrigins: csvSet(env.AGENT_CONNECT_ALLOWED_ORIGINS),
    dynamicAppEnrollment:
      env.AGENT_CONNECT_DYNAMIC_APP_ENROLLMENT === "1" ||
      env.AGENT_CONNECT_DYNAMIC_APP_ENROLLMENT === "true",
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
    ...(env.AGENT_CONNECT_STATE_PATH
      ? { authStatePath: env.AGENT_CONNECT_STATE_PATH }
      : {}),
    ...(env.AGENT_CONNECT_PUBLIC_ENDPOINT
      ? { publicEndpoint: env.AGENT_CONNECT_PUBLIC_ENDPOINT }
      : {}),
    ...(transportProfile ? { transportProfile } : {}),
    ...(publicDemoAuthorities ? { publicDemoAuthorities } : {}),
    ...(env.AGENT_CONNECT_ENROLLMENT_PASSPHRASE
      ? { enrollmentPassphrase: env.AGENT_CONNECT_ENROLLMENT_PASSPHRASE }
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

function sandboxFromEnv(
  env: NodeJS.ProcessEnv,
): GatewayRuntimeConfig["omnigentSandbox"] | undefined {
  const type = env.AGENT_CONNECT_OMNIGENT_SANDBOX;
  if (!type) return undefined;
  if (type !== "linux_bwrap") {
    throw new TypeError(`Invalid AGENT_CONNECT_OMNIGENT_SANDBOX: ${type}`);
  }
  const codexHome = requiredEnv(env, "AGENT_CONNECT_SANDBOX_CODEX_HOME");
  const hostSentinel = requiredEnv(env, "AGENT_CONNECT_SANDBOX_HOST_SENTINEL");
  return {
    type,
    codexHome,
    hostSentinel,
    readPaths: (env.AGENT_CONNECT_SANDBOX_READ_PATHS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function csvSet(value: string | undefined): ReadonlySet<string> {
  return new Set(csvValues(value ?? ""));
}

function csvValues(value: string): readonly string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
