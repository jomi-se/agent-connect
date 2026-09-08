import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import compatibility from "../../../../config/openclaw-test-compat.json" with { type: "json" };
import { ConnectorAuth } from "../connector-auth.js";
import { DelegatedGrantService } from "../delegated-grants.js";
import { loadStaticOpenClawPolicy } from "./policy.js";
import {
  createOpenClawRuntimePolicyVerifier,
  readStockOpenClawConfig,
  readStockOpenClawRpc,
} from "./runtime-config.js";
import type { ScopedResponsesProxyOptions } from "./server.js";

export interface ScopedProxyRuntimeConfig extends ScopedResponsesProxyOptions {
  readonly host: string;
  readonly port: number;
  readonly ownerStatePath: string;
  readonly grantStatePath: string;
  readonly openclawBin: string;
}

export async function scopedProxyConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScopedProxyRuntimeConfig> {
  requireSupportedNode();
  const host = env.AGENT_CONNECT_HOST ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new TypeError(
      "The scoped proxy must listen on loopback behind operator-managed HTTPS ingress",
    );
  }
  const issuer = canonicalHttpsOrigin(
    required(env, "AGENT_CONNECT_PUBLIC_ENDPOINT"),
  );
  const resource = `${issuer}/v1/responses`;
  const upstreamBaseUrl = loopbackOrigin(required(env, "OPENCLAW_BASE_URL"));
  const upstreamToken = required(env, "OPENCLAW_TOKEN");
  const openclawBin = absolutePath(
    required(env, "OPENCLAW_BIN"),
    "OPENCLAW_BIN",
  );
  verifyPublishedOpenClaw(openclawBin, env);
  const ownerStatePath = absolutePath(
    required(env, "AGENT_CONNECT_STATE_PATH"),
    "AGENT_CONNECT_STATE_PATH",
  );
  if (!existsSync(ownerStatePath)) {
    throw new Error("Gateway owner identity is not initialized");
  }
  const grantStatePath = absolutePath(
    required(env, "AGENT_CONNECT_DELEGATED_GRANT_STATE_PATH"),
    "AGENT_CONNECT_DELEGATED_GRANT_STATE_PATH",
  );
  const staticPolicySnapshot = loadStaticOpenClawPolicy({
    configPath: absolutePath(
      required(env, "OPENCLAW_CONFIG_PATH"),
      "OPENCLAW_CONFIG_PATH",
    ),
    policyPath: absolutePath(
      required(env, "AGENT_CONNECT_SCOPED_POLICIES_PATH"),
      "AGENT_CONNECT_SCOPED_POLICIES_PATH",
    ),
    upstreamToken,
    upstreamBaseUrl,
  });
  const runtimeVerifier = await createOpenClawRuntimePolicyVerifier({
    readConfig: () =>
      readStockOpenClawConfig({ upstreamBaseUrl, upstreamToken }),
    validateSourceConfig: (value) =>
      staticPolicySnapshot.assertRuntimeConfig(value),
  });
  const policySnapshot =
    staticPolicySnapshot.withRuntimeVerifier(runtimeVerifier);
  const grantService = new DelegatedGrantService({
    resource,
    statePath: grantStatePath,
    offeredPolicies: policySnapshot.offeredPolicies,
  });
  const ownerAuth = new ConnectorAuth({
    statePath: ownerStatePath,
    publicEndpoint: issuer,
    transportProfile: "explicit-owner-login",
  });
  return {
    host,
    port: port(required(env, "AGENT_CONNECT_PORT")),
    issuer,
    resource,
    upstreamBaseUrl,
    upstreamToken,
    grantService,
    ownerAuth,
    policySnapshot,
    readHistory: (sessionKey) =>
      readStockOpenClawRpc({ upstreamBaseUrl, upstreamToken }, "chat.history", {
        sessionKey,
        limit: 200,
      }),
    ownerStatePath,
    grantStatePath,
    openclawBin,
    upstreamTimeoutMs: positiveInteger(
      env.AGENT_CONNECT_UPSTREAM_TIMEOUT_MS ?? "1800000",
      "AGENT_CONNECT_UPSTREAM_TIMEOUT_MS",
    ),
  };
}

export function verifyPublishedOpenClaw(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const resolved = realpathSync(binary);
  const packageDirectory = dirname(resolved);
  const packageJson = JSON.parse(
    readFileSync(join(packageDirectory, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const installRoot = dirname(dirname(packageDirectory));
  const lock = JSON.parse(
    readFileSync(join(installRoot, "package-lock.json"), "utf8"),
  ) as {
    packages?: Record<
      string,
      { version?: string; resolved?: string; integrity?: string }
    >;
  };
  const locked = lock.packages?.["node_modules/openclaw"];
  const version = execFileSync(binary, ["--version"], {
    env: { PATH: env.PATH },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (
    packageJson.name !== compatibility.package ||
    packageJson.version !== compatibility.version ||
    (packageJson.exports !== null &&
      typeof packageJson.exports === "object" &&
      "./plugin-sdk/openresponses-application-policy" in packageJson.exports) ||
    locked?.version !== compatibility.version ||
    locked.resolved !== compatibility.tarball ||
    locked.integrity !== compatibility.integrity ||
    !new RegExp(`\\b${compatibility.version.replaceAll(".", "\\.")}\\b`).test(
      version,
    )
  ) {
    throw new Error(
      "OPENCLAW_BIN is not the integrity-pinned, unpatched published package",
    );
  }
}

function requireSupportedNode(): void {
  const [major = 0, minor = 0, patch = 0] = process.versions.node
    .split(".")
    .map(Number);
  const [requiredMajor = 0, requiredMinor = 0, requiredPatch = 0] =
    compatibility.minimumNodeVersion.split(".").map(Number);
  if (
    major !== requiredMajor ||
    major >= compatibility.maximumNodeMajorExclusive ||
    minor < requiredMinor ||
    (minor === requiredMinor && patch < requiredPatch)
  ) {
    throw new Error(
      `Scoped proxy requires Node >=${compatibility.minimumNodeVersion} <${compatibility.maximumNodeMajorExclusive}`,
    );
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function absolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  return value;
}

function canonicalHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    value !== url.origin ||
    url.username ||
    url.password
  ) {
    throw new TypeError(
      "AGENT_CONNECT_PUBLIC_ENDPOINT must be a canonical HTTPS origin",
    );
  }
  return value;
}

function loopbackOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    value !== url.origin ||
    !url.port ||
    !isLoopbackHost(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new TypeError(
      "OPENCLAW_BASE_URL must be an explicit loopback HTTP origin",
    );
  }
  return value;
}

function isLoopbackHost(value: string): boolean {
  return ["127.0.0.1", "::1", "[::1]"].includes(value);
}

function port(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError("AGENT_CONNECT_PORT must be a valid TCP port");
  }
  return parsed;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}
