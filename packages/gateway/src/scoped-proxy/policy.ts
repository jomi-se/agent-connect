import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type {
  DelegatedNativeCapability,
  OfferedDelegatedPolicy,
} from "../delegated-grants.js";

export interface ScopedProxyPolicyFile {
  readonly version: 1;
  readonly policies: readonly {
    readonly ref: string;
    readonly label: string;
    readonly description?: string;
    readonly agentId: string;
    readonly nativeCapabilities: readonly DelegatedNativeCapability[];
  }[];
}

export interface StaticOpenClawPolicySnapshot {
  readonly configPath: string;
  readonly policyPath: string;
  readonly configHash: string;
  readonly policyHash: string;
  readonly offeredPolicies: readonly OfferedDelegatedPolicy[];
  assertUnchanged(): void;
}

type JsonRecord = Record<string, unknown>;

const CAPABILITY_TO_TOOLS: Record<
  DelegatedNativeCapability,
  readonly string[]
> = {
  public_web_search: ["web_search"],
  sandbox_code_execution: ["exec", "process"],
};

export function loadStaticOpenClawPolicy(options: {
  readonly configPath: string;
  readonly policyPath: string;
  readonly upstreamToken: string;
  readonly upstreamBaseUrl: string;
}): StaticOpenClawPolicySnapshot {
  requirePrivateAbsoluteFile(options.configPath, "OPENCLAW_CONFIG_PATH");
  requirePrivateAbsoluteFile(
    options.policyPath,
    "AGENT_CONNECT_SCOPED_POLICIES_PATH",
  );
  const configBytes = readFileSync(options.configPath);
  const policyBytes = readFileSync(options.policyPath);
  const config = parseRecord(configBytes, "OpenClaw config");
  const policyFile = parsePolicyFile(policyBytes);
  validateUpstreamConfig(config, options);
  const configHash = sha256(configBytes);
  const policyHash = sha256(policyBytes);
  const offeredPolicies = policyFile.policies.map((policy) => {
    validateDedicatedAgent(config, policy);
    return {
      ...policy,
      fingerprint: `sha256:${sha256(
        JSON.stringify({ configHash, policyHash, policy }),
      )}`,
    };
  });
  return {
    configPath: options.configPath,
    policyPath: options.policyPath,
    configHash,
    policyHash,
    offeredPolicies,
    assertUnchanged() {
      assertSameHash(options.configPath, configHash, "OpenClaw config");
      assertSameHash(options.policyPath, policyHash, "scoped policy");
    },
  };
}

function validateUpstreamConfig(
  config: JsonRecord,
  options: {
    readonly upstreamToken: string;
    readonly upstreamBaseUrl: string;
  },
): void {
  const gateway = record(config.gateway);
  const auth = record(gateway?.auth);
  const http = record(gateway?.http);
  const endpoints = record(http?.endpoints);
  const responses = record(endpoints?.responses);
  const reload = record(gateway?.reload);
  const upstream = new URL(options.upstreamBaseUrl);
  if (
    gateway?.mode !== "local" ||
    gateway.bind !== "loopback" ||
    gateway.port !== Number(upstream.port) ||
    auth?.mode !== "token" ||
    typeof auth.token !== "string" ||
    !sameSecret(auth.token, options.upstreamToken) ||
    responses?.enabled !== true ||
    reload?.mode !== "off"
  ) {
    throw new Error(
      "OpenClaw config must pin local loopback/port, the exact operator token, Responses enabled, and gateway.reload.mode=off",
    );
  }
  const globalTools = record(config.tools);
  const elevated = record(globalTools?.elevated);
  const defaults = record(record(config.agents)?.defaults);
  const plugins = record(config.plugins);
  const pluginSlots = record(plugins?.slots);
  const pluginEntries = record(plugins?.entries);
  const memoryCore = record(pluginEntries?.["memory-core"]);
  if (
    globalTools?.toolSearch !== false ||
    elevated?.enabled !== false ||
    defaults?.skipBootstrap !== true ||
    pluginSlots?.memory !== "none" ||
    memoryCore?.enabled !== false
  ) {
    throw new Error(
      "OpenClaw config must disable tool search, elevation, bootstrap and memory plugins",
    );
  }
}

function validateDedicatedAgent(
  config: JsonRecord,
  policy: ScopedProxyPolicyFile["policies"][number],
): void {
  requireIdentity(policy.ref, "policy ref");
  requireIdentity(policy.label, "policy label");
  requireIdentity(policy.agentId, "agent id");
  if (policy.description !== undefined)
    requireIdentity(policy.description, "policy description");
  const capabilities = [...policy.nativeCapabilities];
  if (
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some((value) => !(value in CAPABILITY_TO_TOOLS))
  ) {
    throw new Error(`Invalid native capability list for policy ${policy.ref}`);
  }
  const agents = record(config.agents);
  const entries = record(agents?.entries);
  const agent = record(entries?.[policy.agentId]);
  const tools = record(agent?.tools);
  const model = record(agent?.model);
  const memorySearch = record(record(agent?.memory)?.search);
  const expectedTools = [
    ...new Set(capabilities.flatMap((value) => CAPABILITY_TO_TOOLS[value])),
  ].sort();
  if (
    !agent ||
    !isAbsoluteString(agent.workspace ?? agent.cwd) ||
    agent.contextInjection !== "never" ||
    typeof model?.primary !== "string" ||
    !model.primary.trim() ||
    !Array.isArray(model.fallbacks) ||
    model.fallbacks.length > 0 ||
    !exactStrings(agent.skills, []) ||
    memorySearch?.enabled !== false ||
    !tools ||
    hasConditionalToolPolicy(tools)
  ) {
    throw new Error(`Dedicated agent ${policy.agentId} is not closed`);
  }
  if (expectedTools.length === 0) {
    if (!exactStrings(tools.deny, ["*"]) || strings(tools.allow)?.length) {
      throw new Error(
        `Dedicated agent ${policy.agentId} must use exact tools.deny=["*"]`,
      );
    }
  } else if (
    !exactStrings(tools.allow, expectedTools) ||
    strings(tools.deny)?.length
  ) {
    throw new Error(
      `Dedicated agent ${policy.agentId} tool allowlist does not match its declared native capabilities`,
    );
  }
  const sandbox = record(agent.sandbox);
  if (capabilities.includes("sandbox_code_execution")) {
    const docker = record(sandbox?.docker);
    if (
      sandbox?.mode !== "all" ||
      sandbox.scope !== "session" ||
      !["ro", "none"].includes(String(sandbox.workspaceAccess)) ||
      !["docker", "podman"].includes(String(sandbox.backend)) ||
      !exactStrings(docker?.binds, []) ||
      docker?.network !== "none"
    ) {
      throw new Error(
        `Dedicated agent ${policy.agentId} must use a per-session, no-egress container sandbox without host binds`,
      );
    }
  }
}

function parsePolicyFile(bytes: Buffer): ScopedProxyPolicyFile {
  const value = parseRecord(bytes, "scoped policy");
  if (
    value.version !== 1 ||
    !Array.isArray(value.policies) ||
    value.policies.length === 0 ||
    value.policies.length > 16
  ) {
    throw new Error(
      "Scoped policy file must contain version 1 and 1-16 policies",
    );
  }
  const policies = value.policies as ScopedProxyPolicyFile["policies"];
  if (new Set(policies.map((policy) => policy.ref)).size !== policies.length) {
    throw new Error("Scoped policy refs must be unique");
  }
  return { version: 1, policies };
}

function parseRecord(bytes: Buffer, label: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  const parsed = record(value);
  if (!parsed) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function requirePrivateAbsoluteFile(path: string, name: string): void {
  if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`${name} must name a regular file`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`${name} must not be accessible to group or others`);
  }
}

function assertSameHash(path: string, expected: string, label: string): void {
  let actual: string;
  try {
    actual = sha256(readFileSync(path));
  } catch {
    throw new Error(`${label} is unavailable; restart and reconsent required`);
  }
  if (actual !== expected) {
    throw new Error(`${label} changed; restart and reconsent required`);
  }
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("base64url");
}

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function exactStrings(value: unknown, expected: readonly string[]): boolean {
  const actual = strings(value);
  return (
    actual !== undefined &&
    [...new Set(actual)].sort().join("\0") === [...expected].sort().join("\0")
  );
}

function hasConditionalToolPolicy(tools: JsonRecord): boolean {
  return ["alsoAllow", "profile", "byProvider", "toolsBySender"].some(
    (key) => tools[key] !== undefined,
  );
}

function requireIdentity(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

function isAbsoluteString(value: unknown): boolean {
  return typeof value === "string" && isAbsolute(value);
}
