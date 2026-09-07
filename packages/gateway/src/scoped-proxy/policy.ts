import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type {
  DelegatedNativeCapability,
  OfferedDelegatedPolicy,
} from "../delegated-grants.js";
import type { OpenClawRuntimePolicyVerifier } from "./runtime-config.js";

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
  assertRuntimeConfig(value: unknown): void;
  assertRuntimeCurrent(): Promise<void>;
  withRuntimeVerifier(
    verifier: OpenClawRuntimePolicyVerifier,
  ): StaticOpenClawPolicySnapshot;
}

type JsonRecord = Record<string, unknown>;
type Policy = ScopedProxyPolicyFile["policies"][number];

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
  validatePolicyConfig(config, options, policyFile.policies, false);
  const configHash = sha256(configBytes);
  const policyHash = sha256(policyBytes);

  const buildSnapshot = (
    runtimeVerifier?: OpenClawRuntimePolicyVerifier,
  ): StaticOpenClawPolicySnapshot => ({
    configPath: options.configPath,
    policyPath: options.policyPath,
    configHash,
    policyHash,
    offeredPolicies: policyFile.policies.map((policy) => ({
      ...policy,
      fingerprint: `sha256:${sha256(
        JSON.stringify({
          configHash,
          policyHash,
          ...(runtimeVerifier
            ? { appliedConfigHash: runtimeVerifier.appliedConfigHash }
            : {}),
          policy,
        }),
      )}`,
    })),
    assertUnchanged() {
      assertSameHash(options.configPath, configHash, "OpenClaw config");
      assertSameHash(options.policyPath, policyHash, "scoped policy");
    },
    assertRuntimeConfig(value: unknown) {
      validatePolicyConfig(
        requiredRecord(value, "OpenClaw config.get sourceConfig"),
        options,
        policyFile.policies,
        true,
      );
    },
    async assertRuntimeCurrent() {
      if (!runtimeVerifier)
        throw new Error("OpenClaw runtime revision has not been bound");
      await runtimeVerifier.assertCurrent();
    },
    withRuntimeVerifier(verifier) {
      assertSameHash(options.configPath, configHash, "OpenClaw config");
      assertSameHash(options.policyPath, policyHash, "scoped policy");
      return buildSnapshot(verifier);
    },
  });
  return buildSnapshot();
}

function validatePolicyConfig(
  config: JsonRecord,
  options: { readonly upstreamToken: string; readonly upstreamBaseUrl: string },
  policies: readonly Policy[],
  redacted: boolean,
): void {
  assertOnlyKeys(
    config,
    ["gateway", "auth", "agents", "tools", "plugins"],
    "root",
  );
  const gateway = requiredRecord(config.gateway, "gateway");
  const gatewayAuth = requiredRecord(gateway.auth, "gateway.auth");
  const reload = requiredRecord(gateway.reload, "gateway.reload");
  const http = requiredRecord(gateway.http, "gateway.http");
  const endpoints = requiredRecord(http.endpoints, "gateway.http.endpoints");
  const responses = requiredRecord(
    endpoints.responses,
    "gateway.http.endpoints.responses",
  );
  assertOnlyKeys(
    gateway,
    ["mode", "bind", "port", "auth", "reload", "http"],
    "gateway",
  );
  assertOnlyKeys(gatewayAuth, ["mode", "token"], "gateway.auth");
  assertOnlyKeys(reload, ["mode"], "gateway.reload");
  assertOnlyKeys(http, ["endpoints"], "gateway.http");
  assertOnlyKeys(endpoints, ["responses"], "gateway.http.endpoints");
  assertOnlyKeys(responses, ["enabled"], "gateway.http.endpoints.responses");
  const upstream = new URL(options.upstreamBaseUrl);
  const tokenMatches = redacted
    ? gatewayAuth.token === "__OPENCLAW_REDACTED__"
    : typeof gatewayAuth.token === "string" &&
      sameSecret(gatewayAuth.token, options.upstreamToken);
  if (
    gateway.mode !== "local" ||
    gateway.bind !== "loopback" ||
    gateway.port !== Number(upstream.port) ||
    gatewayAuth.mode !== "token" ||
    !tokenMatches ||
    responses.enabled !== true ||
    reload.mode !== "off"
  ) {
    throw new Error(
      "OpenClaw config must pin local loopback/port, the exact operator token, Responses enabled, and gateway.reload.mode=off",
    );
  }

  const agents = requiredRecord(config.agents, "agents");
  const defaults = requiredRecord(agents.defaults, "agents.defaults");
  const entries = requiredRecord(agents.entries, "agents.entries");
  assertOnlyKeys(agents, ["defaults", "entries"], "agents");
  validateDefaults(defaults);
  if (Object.keys(entries).length !== 1)
    throw new Error(
      "The scoped profile must contain exactly one dedicated agent",
    );

  const globalTools = requiredRecord(config.tools, "tools");
  const elevated = requiredRecord(globalTools.elevated, "tools.elevated");
  assertOnlyKeys(globalTools, ["toolSearch", "elevated"], "tools");
  assertOnlyKeys(elevated, ["enabled"], "tools.elevated");
  const plugins = requiredRecord(config.plugins, "plugins");
  const pluginSlots = requiredRecord(plugins.slots, "plugins.slots");
  const pluginEntries = requiredRecord(plugins.entries, "plugins.entries");
  const memoryCore = requiredRecord(
    pluginEntries["memory-core"],
    "plugins.entries.memory-core",
  );
  assertOnlyKeys(plugins, ["slots", "entries"], "plugins");
  assertOnlyKeys(pluginSlots, ["memory"], "plugins.slots");
  assertOnlyKeys(pluginEntries, ["memory-core"], "plugins.entries");
  assertOnlyKeys(memoryCore, ["enabled"], "plugins.entries.memory-core");
  if (
    globalTools.toolSearch !== false ||
    elevated.enabled !== false ||
    defaults.skipBootstrap !== true ||
    pluginSlots.memory !== "none" ||
    memoryCore.enabled !== false
  )
    throw new Error(
      "OpenClaw config must disable tool search, elevation, bootstrap and memory plugins",
    );

  validateProviderAuth(requiredRecord(config.auth, "auth"));
  for (const policy of policies) validateDedicatedAgent(config, policy);
}

function validateDefaults(defaults: JsonRecord): void {
  assertOnlyKeys(
    defaults,
    ["skipBootstrap", "heartbeat", "timeoutSeconds", "models"],
    "agents.defaults",
  );
  const heartbeat = requiredRecord(
    defaults.heartbeat,
    "agents.defaults.heartbeat",
  );
  const models = requiredRecord(defaults.models, "agents.defaults.models");
  assertOnlyKeys(heartbeat, ["every"], "agents.defaults.heartbeat");
  if (
    heartbeat.every !== "0m" ||
    typeof defaults.timeoutSeconds !== "number" ||
    !Number.isInteger(defaults.timeoutSeconds) ||
    defaults.timeoutSeconds < 1 ||
    defaults.timeoutSeconds > 1800 ||
    Object.keys(models).length !== 1
  )
    throw new Error(
      "OpenClaw agent defaults must match the narrow scoped template",
    );
  for (const [modelId, value] of Object.entries(models)) {
    requireIdentity(modelId, "default model id");
    const model = requiredRecord(value, `agents.defaults.models.${modelId}`);
    const runtime = requiredRecord(
      model.agentRuntime,
      `agents.defaults.models.${modelId}.agentRuntime`,
    );
    assertOnlyKeys(
      model,
      ["agentRuntime"],
      `agents.defaults.models.${modelId}`,
    );
    assertOnlyKeys(
      runtime,
      ["id"],
      `agents.defaults.models.${modelId}.agentRuntime`,
    );
    if (runtime.id !== "openclaw")
      throw new Error(
        "OpenClaw default model must pin agentRuntime.id=openclaw",
      );
  }
}

function validateProviderAuth(auth: JsonRecord): void {
  assertOnlyKeys(auth, ["profiles", "order"], "auth");
  const profiles = requiredRecord(auth.profiles, "auth.profiles");
  const order = requiredRecord(auth.order, "auth.order");
  if (Object.keys(profiles).length !== 1 || Object.keys(order).length !== 1) {
    throw new Error(
      "OpenClaw auth must select exactly one OAuth provider profile",
    );
  }
  for (const [profileId, value] of Object.entries(profiles)) {
    requireIdentity(profileId, "auth profile id");
    const profile = requiredRecord(value, `auth.profiles.${profileId}`);
    assertOnlyKeys(profile, ["provider", "mode"], `auth.profiles.${profileId}`);
    if (
      typeof profile.provider !== "string" ||
      profile.mode !== "oauth" ||
      !exactStrings(order[profile.provider], [profileId])
    )
      throw new Error(
        "OpenClaw auth must use one exactly ordered OAuth profile",
      );
  }
}

function validateDedicatedAgent(config: JsonRecord, policy: Policy): void {
  requireIdentity(policy.ref, "policy ref");
  requireIdentity(policy.label, "policy label");
  requireIdentity(policy.agentId, "agent id");
  if (policy.description !== undefined)
    requireIdentity(policy.description, "policy description");
  const capabilities = [...policy.nativeCapabilities];
  if (
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some((value) => !(value in CAPABILITY_TO_TOOLS))
  )
    throw new Error(`Invalid native capability list for policy ${policy.ref}`);
  const entries = requiredRecord(
    requiredRecord(config.agents, "agents").entries,
    "agents.entries",
  );
  const agent = requiredRecord(
    entries[policy.agentId],
    `agents.entries.${policy.agentId}`,
  );
  if (Object.keys(entries)[0] !== policy.agentId)
    throw new Error(`Dedicated agent ${policy.agentId} is not the sole agent`);
  assertOnlyKeys(
    agent,
    [
      "workspace",
      "cwd",
      "contextInjection",
      "model",
      "skills",
      "memory",
      "tools",
      "sandbox",
    ],
    `agents.entries.${policy.agentId}`,
  );
  if (agent.workspace !== undefined && agent.cwd !== undefined)
    throw new Error(
      `Dedicated agent ${policy.agentId} has two workspace roots`,
    );
  const tools = requiredRecord(
    agent.tools,
    `agents.entries.${policy.agentId}.tools`,
  );
  const model = requiredRecord(
    agent.model,
    `agents.entries.${policy.agentId}.model`,
  );
  const memory = requiredRecord(
    agent.memory,
    `agents.entries.${policy.agentId}.memory`,
  );
  const memorySearch = requiredRecord(
    memory.search,
    `agents.entries.${policy.agentId}.memory.search`,
  );
  assertOnlyKeys(
    model,
    ["primary", "fallbacks"],
    `agents.entries.${policy.agentId}.model`,
  );
  assertOnlyKeys(memory, ["search"], `agents.entries.${policy.agentId}.memory`);
  assertOnlyKeys(
    memorySearch,
    ["enabled"],
    `agents.entries.${policy.agentId}.memory.search`,
  );
  assertOnlyKeys(
    tools,
    ["allow", "deny"],
    `agents.entries.${policy.agentId}.tools`,
  );
  const expectedTools = [
    ...new Set(capabilities.flatMap((value) => CAPABILITY_TO_TOOLS[value])),
  ].sort();
  if (
    !isAbsoluteString(agent.workspace ?? agent.cwd) ||
    agent.contextInjection !== "never" ||
    typeof model.primary !== "string" ||
    !model.primary.trim() ||
    !exactStrings(model.fallbacks, []) ||
    !exactStrings(agent.skills, []) ||
    memorySearch.enabled !== false
  )
    throw new Error(`Dedicated agent ${policy.agentId} is not closed`);
  const defaults = requiredRecord(
    requiredRecord(config.agents, "agents").defaults,
    "agents.defaults",
  );
  const models = requiredRecord(defaults.models, "agents.defaults.models");
  if (!Object.hasOwn(models, model.primary)) {
    throw new Error(
      `Dedicated agent ${policy.agentId} model is outside the pinned default model`,
    );
  }
  if (expectedTools.length === 0) {
    if (!exactStrings(tools.deny, ["*"]) || tools.allow !== undefined) {
      throw new Error(
        `Dedicated agent ${policy.agentId} must use exact tools.deny=["*"]`,
      );
    }
  } else if (
    !exactStrings(tools.allow, expectedTools) ||
    tools.deny !== undefined
  ) {
    throw new Error(
      `Dedicated agent ${policy.agentId} tool allowlist does not match its declared native capabilities`,
    );
  }
  const sandbox = record(agent.sandbox);
  if (capabilities.includes("sandbox_code_execution")) {
    if (!sandbox)
      throw new Error(`Dedicated agent ${policy.agentId} requires a sandbox`);
    const docker = requiredRecord(
      sandbox.docker,
      `agents.entries.${policy.agentId}.sandbox.docker`,
    );
    assertOnlyKeys(
      sandbox,
      ["mode", "backend", "scope", "workspaceAccess", "docker"],
      `agents.entries.${policy.agentId}.sandbox`,
    );
    assertOnlyKeys(
      docker,
      ["network", "binds"],
      `agents.entries.${policy.agentId}.sandbox.docker`,
    );
    if (
      sandbox.mode !== "all" ||
      sandbox.scope !== "session" ||
      !["ro", "none"].includes(String(sandbox.workspaceAccess)) ||
      !["docker", "podman"].includes(String(sandbox.backend)) ||
      !exactStrings(docker.binds, []) ||
      docker.network !== "none"
    )
      throw new Error(
        `Dedicated agent ${policy.agentId} must use a per-session, no-egress container sandbox without host binds`,
      );
  } else if (sandbox) {
    throw new Error(
      `Dedicated agent ${policy.agentId} must omit sandbox without code execution`,
    );
  }
}

function parsePolicyFile(bytes: Buffer): ScopedProxyPolicyFile {
  const value = parseRecord(bytes, "scoped policy");
  assertOnlyKeys(value, ["version", "policies"], "scoped policy");
  if (
    value.version !== 1 ||
    !Array.isArray(value.policies) ||
    value.policies.length === 0 ||
    value.policies.length > 16
  )
    throw new Error(
      "Scoped policy file must contain version 1 and 1-16 policies",
    );
  const policies = value.policies as ScopedProxyPolicyFile["policies"];
  if (new Set(policies.map((policy) => policy.ref)).size !== policies.length)
    throw new Error("Scoped policy refs must be unique");
  for (const policy of policies) {
    const value = requiredRecord(policy, "scoped policy entry");
    assertOnlyKeys(
      value,
      ["ref", "label", "description", "agentId", "nativeCapabilities"],
      `scoped policy ${String(value.ref)}`,
    );
  }
  return { version: 1, policies };
}

function parseRecord(bytes: Buffer, label: string): JsonRecord {
  try {
    return requiredRecord(JSON.parse(bytes.toString("utf8")), label);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(`${label} must be valid JSON`);
    throw error;
  }
}

function requiredRecord(value: unknown, label: string): JsonRecord {
  const parsed = record(value);
  if (!parsed) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function requirePrivateAbsoluteFile(path: string, name: string): void {
  if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`${name} must name a regular file`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    throw new Error(`${name} must not be accessible to group or others`);
}

function assertSameHash(path: string, expected: string, label: string): void {
  let actual: string;
  try {
    actual = sha256(readFileSync(path));
  } catch {
    throw new Error(`${label} is unavailable; restart and reconsent required`);
  }
  if (actual !== expected)
    throw new Error(`${label} changed; restart and reconsent required`);
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

function assertOnlyKeys(
  value: JsonRecord,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    throw new Error(
      `${label} contains unsupported fields: ${unknown.join(", ")}`,
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
  )
    throw new Error(`Invalid ${label}`);
}

function isAbsoluteString(value: unknown): boolean {
  return typeof value === "string" && isAbsolute(value);
}
