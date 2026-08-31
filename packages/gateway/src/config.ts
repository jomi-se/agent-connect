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
  const host = env.AGENT_CONNECT_HOST ?? "127.0.0.1";
  const dynamicAppEnrollment =
    env.AGENT_CONNECT_DYNAMIC_APP_ENROLLMENT === "1" ||
    env.AGENT_CONNECT_DYNAMIC_APP_ENROLLMENT === "true";
  if (
    (transportProfile === "tailscale-serve" || dynamicAppEnrollment) &&
    host !== "127.0.0.1" &&
    host !== "::1"
  ) {
    throw new TypeError(
      "tailscale-serve and dynamic enrollment require a loopback gateway host",
    );
  }
  return {
    host,
    port: parsePort(env.AGENT_CONNECT_PORT ?? "8787"),
    omnigentBaseUrl: env.OMNIGENT_URL ?? "http://127.0.0.1:6767",
    workspace: env.AGENT_CONNECT_WORKSPACE ?? process.cwd(),
    ...(env.AGENT_CONNECT_OMNIGENT_HOST_ID
      ? { omnigentHostId: env.AGENT_CONNECT_OMNIGENT_HOST_ID }
      : {}),
    ...(sandbox ? { omnigentSandbox: sandbox } : {}),
    allowedOrigins: csvSet(env.AGENT_CONNECT_ALLOWED_ORIGINS),
    dynamicAppEnrollment,
    allowedTailscaleUsers: csvSet(env.AGENT_CONNECT_ALLOWED_TAILSCALE_USERS),
    authStatePath: requiredEnv(env, "AGENT_CONNECT_STATE_PATH"),
    ...(env.AGENT_CONNECT_RESPONSE_STATE_PATH
      ? { responseStatePath: env.AGENT_CONNECT_RESPONSE_STATE_PATH }
      : {}),
    publicEndpoint: requiredEnv(env, "AGENT_CONNECT_PUBLIC_ENDPOINT"),
    ...(transportProfile ? { transportProfile } : {}),
    capabilityTtlSeconds: parsePositiveInteger(
      env.AGENT_CONNECT_CAPABILITY_TTL_SECONDS ?? "3600",
      "AGENT_CONNECT_CAPABILITY_TTL_SECONDS",
    ),
    // Session lifetime slides on activity and is deliberately much shorter
    // than the capability TTL: losing the session id means starting over, so
    // holding a slot open for an hour buys nothing and costs a runner.
    sessionIdleTimeoutSeconds: parsePositiveInteger(
      env.AGENT_CONNECT_SESSION_IDLE_TIMEOUT_SECONDS ?? "900",
      "AGENT_CONNECT_SESSION_IDLE_TIMEOUT_SECONDS",
    ),
    parkedCallTimeoutSeconds: parsePositiveInteger(
      env.AGENT_CONNECT_PARKED_CALL_TIMEOUT_SECONDS ?? "180",
      "AGENT_CONNECT_PARKED_CALL_TIMEOUT_SECONDS",
    ),
    runningTurnTimeoutSeconds: parsePositiveInteger(
      env.AGENT_CONNECT_RUNNING_TURN_TIMEOUT_SECONDS ?? "1800",
      "AGENT_CONNECT_RUNNING_TURN_TIMEOUT_SECONDS",
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
