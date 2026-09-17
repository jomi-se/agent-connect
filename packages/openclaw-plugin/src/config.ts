import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { OfferedDelegatedPolicy } from "./delegated-grants.js";
import type { OpenClawUpstreamAuth } from "./runtime/upstream-auth.js";

export const PLUGIN_ID = "agent-connect";
export const DEFAULT_AGENT_ID = "agent-connect-app";
export const DEFAULT_LISTEN_PORT = 18_790;
export const POLICY_REF = "application-tools-only";
const MAX_ENTRY_POINTS = 16;

export interface AgentConnectOpenClawPluginEntryPoint {
  readonly id: string;
  readonly publicOrigin: string;
  readonly listenPort: number;
}

export interface SingleEntryPointPluginConfig {
  readonly publicOrigin: string;
  readonly agentId: string;
  readonly listenPort: number;
  readonly model?: string;
}

export interface MultipleEntryPointPluginConfig {
  readonly entryPoints: readonly AgentConnectOpenClawPluginEntryPoint[];
  readonly agentId: string;
  readonly model?: string;
}

export type AgentConnectOpenClawPluginConfig =
  SingleEntryPointPluginConfig | MultipleEntryPointPluginConfig;

export interface SupportedRuntime {
  readonly entryPointId: string;
  readonly publicOrigin: string;
  readonly issuer: string;
  readonly resource: string;
  readonly agentId: string;
  readonly listenPort: number;
  readonly upstreamBaseUrl: string;
  readonly upstreamAuth: OpenClawUpstreamAuth;
  readonly fingerprint: string;
  readonly policy: OfferedDelegatedPolicy;
}

export interface SetupInspection {
  readonly supported: boolean;
  readonly changes: readonly string[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly config: AgentConnectOpenClawPluginConfig;
}

export interface SetupReadiness {
  readonly ok: boolean;
  readonly status:
    "ready" | "unsupported_host" | "setup_required" | "owner_identity_missing";
}

export interface ResolvedGatewayAuthView {
  readonly mode: unknown;
  readonly token?: string;
  readonly password?: string;
}

export type GatewayAuthResolver = (options: {
  readonly authConfig?: Record<string, unknown> | null;
  readonly env?: NodeJS.ProcessEnv;
}) => ResolvedGatewayAuthView;

interface ConfigInspectionOptions {
  readonly stateDir: string;
  readonly resolveGatewayAuth: GatewayAuthResolver;
}

interface HostRuntimeSettingsInspection {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly auth?: OpenClawUpstreamAuth;
  readonly port?: number;
}

export function parsePluginConfig(
  value: unknown,
): AgentConnectOpenClawPluginConfig {
  const input = record(value);
  if (!input) throw new Error("Agent Connect setup has not been applied");
  if (input.entryPoints !== undefined) {
    exactKeys(input, ["entryPoints", "agentId", "model"], "plugin config");
    if (
      !Array.isArray(input.entryPoints) ||
      input.entryPoints.length === 0 ||
      input.entryPoints.length > MAX_ENTRY_POINTS
    ) {
      throw new Error(
        `entryPoints must contain between 1 and ${MAX_ENTRY_POINTS} entries`,
      );
    }
    const entryPoints = input.entryPoints.map((value, index) => {
      const entry = record(value);
      if (!entry) throw new Error(`entryPoints[${index}] must be an object`);
      exactKeys(
        entry,
        ["id", "publicOrigin", "listenPort"],
        `entryPoints[${index}]`,
      );
      return {
        id: identifier(entry.id, `entryPoints[${index}].id`),
        publicOrigin: canonicalHttpsOrigin(entry.publicOrigin),
        listenPort: port(entry.listenPort, `entryPoints[${index}].listenPort`),
      };
    });
    requireUniqueEntryPoints(entryPoints);
    return {
      entryPoints,
      agentId: identifier(input.agentId, "agentId"),
      ...(input.model === undefined
        ? {}
        : { model: modelIdentifier(input.model) }),
    };
  }
  exactKeys(
    input,
    ["publicOrigin", "agentId", "listenPort", "model"],
    "plugin config",
  );
  return {
    publicOrigin: canonicalHttpsOrigin(input.publicOrigin),
    agentId: identifier(input.agentId, "agentId"),
    listenPort: port(input.listenPort ?? DEFAULT_LISTEN_PORT, "listenPort"),
    ...(input.model === undefined
      ? {}
      : { model: modelIdentifier(input.model) }),
  };
}

export function configuredEntryPoints(
  config: AgentConnectOpenClawPluginConfig,
): readonly AgentConnectOpenClawPluginEntryPoint[] {
  return "entryPoints" in config
    ? config.entryPoints
    : [
        {
          id: "default",
          publicOrigin: config.publicOrigin,
          listenPort: config.listenPort,
        },
      ];
}

export function primaryEntryPoint(
  config: AgentConnectOpenClawPluginConfig,
): AgentConnectOpenClawPluginEntryPoint {
  return configuredEntryPoints(config)[0]!;
}

export function inspectSetup(
  value: unknown,
  requested: AgentConnectOpenClawPluginConfig,
  options: ConfigInspectionOptions,
): SetupInspection {
  const config = record(value) ?? {};
  const changes: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const gateway = record(config.gateway) ?? {};
  const host = inspectHostRuntimeSettings(config, options.resolveGatewayAuth);
  errors.push(...host.errors);
  warnings.push(...host.warnings);
  for (const entryPoint of configuredEntryPoints(requested)) {
    if (host.port === entryPoint.listenPort) {
      errors.push(
        `${entryPointLabel(entryPoint)}listenPort must differ from gateway.port so application routes cannot share the native OpenClaw listener`,
      );
    }
  }
  const http = record(gateway.http) ?? {};
  const endpoints = record(http.endpoints) ?? {};
  const responses = record(endpoints.responses) ?? {};
  if (responses.enabled !== true)
    changes.push("enable gateway.http.endpoints.responses");

  const agents = record(config.agents) ?? {};
  const entries = record(agents.entries) ?? {};
  const existingAgent = entries[requested.agentId];
  const expectedAgent = restrictedAgentConfig(
    options.stateDir,
    requested.model,
  );
  if (existingAgent === undefined) {
    changes.push(`add restricted agent ${requested.agentId}`);
  } else if (!sameJson(existingAgent, expectedAgent)) {
    if (isManagedRestrictedAgent(existingAgent, options.stateDir)) {
      changes.push(`update managed restricted agent ${requested.agentId}`);
    } else {
      errors.push(
        `agents.entries.${requested.agentId} already exists and is not the Agent Connect restricted recipe`,
      );
    }
  }

  const pluginEntry = record(record(config.plugins)?.entries)?.[PLUGIN_ID];
  const currentPluginConfig = record(pluginEntry)?.config;
  if (!sameJson(currentPluginConfig, requested)) {
    changes.push("set plugins.entries.agent-connect.config");
  }

  return {
    supported: errors.length === 0,
    changes,
    errors,
    warnings,
    config: requested,
  };
}

export function setupReadiness(
  inspection: SetupInspection,
  ownerIdentityReady: boolean,
): SetupReadiness {
  if (!inspection.supported) {
    return { ok: false, status: "unsupported_host" };
  }
  if (inspection.changes.length > 0) {
    return { ok: false, status: "setup_required" };
  }
  if (!ownerIdentityReady) {
    return { ok: false, status: "owner_identity_missing" };
  }
  return { ok: true, status: "ready" };
}

export function applySetupMutation(
  draft: Record<string, unknown>,
  requested: AgentConnectOpenClawPluginConfig,
  stateDir: string,
  resolveGatewayAuth: GatewayAuthResolver,
): void {
  const inspection = inspectSetup(draft, requested, {
    stateDir,
    resolveGatewayAuth,
  });
  if (!inspection.supported) throw new Error(inspection.errors.join("; "));

  const gateway = ensureRecord(draft, "gateway");
  const http = ensureRecord(gateway, "http");
  const endpoints = ensureRecord(http, "endpoints");
  const responses = ensureRecord(endpoints, "responses");
  responses.enabled = true;

  const agents = ensureRecord(draft, "agents");
  const entries = ensureRecord(agents, "entries");
  entries[requested.agentId] = restrictedAgentConfig(stateDir, requested.model);

  const plugins = ensureRecord(draft, "plugins");
  const pluginEntries = ensureRecord(plugins, "entries");
  const ownEntry = ensureRecord(pluginEntries, PLUGIN_ID);
  ownEntry.enabled = true;
  ownEntry.config = { ...requested };
}

export function resolveSupportedRuntime(
  value: unknown,
  pluginConfig: AgentConnectOpenClawPluginConfig,
  options: ConfigInspectionOptions,
): SupportedRuntime {
  const runtimes = resolveSupportedRuntimes(value, pluginConfig, options);
  if (runtimes.length !== 1) {
    throw new Error("resolveSupportedRuntime requires exactly one entry point");
  }
  return runtimes[0]!;
}

export function resolveSupportedRuntimes(
  value: unknown,
  pluginConfig: AgentConnectOpenClawPluginConfig,
  options: ConfigInspectionOptions,
): readonly SupportedRuntime[] {
  const config = record(value);
  if (!config) throw new Error("OpenClaw runtime config is unavailable");
  const inspection = inspectSetup(config, pluginConfig, options);
  if (!inspection.supported || inspection.changes.length > 0) {
    throw new Error(
      [
        ...inspection.errors,
        ...inspection.changes.map((item) => `required: ${item}`),
      ].join("; "),
    );
  }
  const host = requireHostRuntimeSettings(config, options.resolveGatewayAuth);
  const relevant = relevantPolicyConfig(config, pluginConfig.agentId);
  return configuredEntryPoints(pluginConfig).map((entryPoint) => {
    const issuer = `${entryPoint.publicOrigin}/agent-connect`;
    const resource = `${issuer}/v1/responses`;
    const fingerprint = `sha256:${createHash("sha256")
      .update(
        canonicalJson(
          entryPoint.id === "default"
            ? {
                pluginConfig: {
                  publicOrigin: entryPoint.publicOrigin,
                  agentId: pluginConfig.agentId,
                  listenPort: entryPoint.listenPort,
                  ...(pluginConfig.model === undefined
                    ? {}
                    : { model: pluginConfig.model }),
                },
                relevant,
              }
            : {
                entryPoint,
                agentId: pluginConfig.agentId,
                model: pluginConfig.model,
                relevant,
              },
        ),
      )
      .digest("hex")}`;
    return {
      entryPointId: entryPoint.id,
      publicOrigin: entryPoint.publicOrigin,
      issuer,
      resource,
      agentId: pluginConfig.agentId,
      listenPort: entryPoint.listenPort,
      upstreamBaseUrl: `http://127.0.0.1:${host.port}`,
      upstreamAuth: host.auth,
      fingerprint,
      policy: {
        ref: POLICY_REF,
        label: "Application tools only",
        description:
          "No native OpenClaw tools, memory, skills, or workspace context",
        agentId: pluginConfig.agentId,
        fingerprint,
        nativeCapabilities: [],
      },
    };
  });
}

function requireUniqueEntryPoints(
  entryPoints: readonly AgentConnectOpenClawPluginEntryPoint[],
): void {
  for (const [field, label] of [
    ["id", "id"],
    ["publicOrigin", "publicOrigin"],
    ["listenPort", "listenPort"],
  ] as const) {
    const values = new Set<string | number>();
    for (const entryPoint of entryPoints) {
      if (values.has(entryPoint[field])) {
        throw new Error(`entryPoints must have unique ${label} values`);
      }
      values.add(entryPoint[field]);
    }
  }
}

function entryPointLabel(
  entryPoint: AgentConnectOpenClawPluginEntryPoint,
): string {
  return entryPoint.id === "default" ? "" : `entry point ${entryPoint.id} `;
}

function inspectHostRuntimeSettings(
  config: Record<string, unknown>,
  resolveGatewayAuth: GatewayAuthResolver,
): HostRuntimeSettingsInspection {
  const gateway = record(config.gateway) ?? {};
  const errors: string[] = [];
  const warnings: string[] = [];
  let upstreamAuth: OpenClawUpstreamAuth | undefined;
  let port: number | undefined;

  let resolvedAuth: ResolvedGatewayAuthView | undefined;
  try {
    resolvedAuth = resolveGatewayAuth({
      authConfig: record(gateway.auth) ?? null,
    });
  } catch {
    errors.push(
      "gateway authentication could not be resolved from the active host configuration",
    );
  }
  const configuredMode = record(gateway.auth)?.mode;
  if (
    typeof configuredMode === "string" &&
    resolvedAuth &&
    configuredMode !== resolvedAuth.mode
  ) {
    errors.push(
      "resolved gateway authentication mode differs from gateway.auth.mode; CLI-only auth overrides are unsupported",
    );
    resolvedAuth = undefined;
  }
  if (resolvedAuth?.mode === "none") {
    upstreamAuth = { mode: "none" };
    warnings.push(
      "native OpenClaw authentication is disabled; exposing its native port would bypass Agent Connect grants and expose the authless native Responses endpoint",
    );
  } else if (
    resolvedAuth?.mode === "token" ||
    resolvedAuth?.mode === "password"
  ) {
    const credential =
      resolvedAuth.mode === "token"
        ? resolvedAuth.token
        : resolvedAuth.password;
    if (typeof credential !== "string" || credential.trim().length === 0) {
      errors.push(
        `gateway.auth.${resolvedAuth.mode} is configured but its credential is unavailable to the active host runtime`,
      );
    } else {
      upstreamAuth = { mode: resolvedAuth.mode, credential };
    }
  } else if (resolvedAuth) {
    errors.push(
      `gateway authentication mode ${String(resolvedAuth.mode)} is unsupported; use token, password, or none without a CLI-only override`,
    );
  }

  if (record(gateway.tls)?.enabled === true) {
    errors.push(
      "gateway.tls.enabled must not be true; terminate public HTTPS outside the loopback listener",
    );
  }

  if (
    !Number.isSafeInteger(gateway.port) ||
    Number(gateway.port) < 1 ||
    Number(gateway.port) > 65_535
  ) {
    errors.push(
      "gateway.port must be an explicit integer from 1 through 65535",
    );
  } else {
    port = Number(gateway.port);
  }

  return {
    errors,
    warnings,
    ...(port === undefined ? {} : { port }),
    ...(upstreamAuth === undefined ? {} : { auth: upstreamAuth }),
  };
}

function requireHostRuntimeSettings(
  config: Record<string, unknown>,
  resolveGatewayAuth: GatewayAuthResolver,
): {
  readonly port: number;
  readonly auth: OpenClawUpstreamAuth;
} {
  const inspected = inspectHostRuntimeSettings(config, resolveGatewayAuth);
  if (
    inspected.errors.length > 0 ||
    inspected.port === undefined ||
    inspected.auth === undefined
  ) {
    throw new Error(inspected.errors.join("; "));
  }
  return { port: inspected.port, auth: inspected.auth };
}

export function restrictedAgentConfig(
  stateDir: string,
  model?: string,
): Record<string, unknown> {
  return {
    name: "Agent Connect application delegation",
    description: "Restricted profile managed by the Agent Connect plugin",
    workspace: resolve(stateDir, "agent-connect", "workspace"),
    contextInjection: "never",
    skills: [],
    memory: {
      search: {
        enabled: false,
        rememberAcrossConversations: false,
      },
    },
    sandbox: { mode: "off", workspaceAccess: "none" },
    // The OpenClaw runtime filters caller-supplied Responses tools through the
    // positive runtime allowlist before applying native-tool denial. Admit
    // arbitrary grant-approved client names, then deny every native tool.
    tools: {
      profile: "full",
      allow: ["*"],
      deny: ["*"],
      elevated: { enabled: false },
    },
    ...(model === undefined
      ? {}
      : {
          model: { primary: model },
          // Agent Connect depends on OpenClaw's caller-supplied Responses
          // tools. External harness runtimes may expose their own dynamic-tool
          // systems without accepting that clientTools surface, so keep this
          // restricted agent on the runtime that implements the contract.
          models: { [model]: { agentRuntime: { id: "openclaw" } } },
        }),
  };
}

function isManagedRestrictedAgent(value: unknown, stateDir: string): boolean {
  if (sameJson(value, restrictedAgentConfig(stateDir))) return true;
  const primary = record(record(value)?.model)?.primary;
  if (
    typeof primary === "string" &&
    sameJson(value, restrictedAgentConfig(stateDir, primary))
  ) {
    return true;
  }
  // Upgrade the exact earlier managed recipes. Do not treat a merely similar
  // operator-owned agent as ours to rewrite.
  return previousManagedRecipes(stateDir, primary).some((recipe) =>
    sameJson(value, recipe),
  );
}

function previousManagedRecipes(
  stateDir: string,
  primary: unknown,
): Record<string, unknown>[] {
  const model = typeof primary === "string" ? primary : undefined;
  const current = restrictedAgentConfig(stateDir, model);
  const { models: _models, ...version007 } = current;
  const tools = record(current.tools)!;
  const { allow: _allow, ...version006Tools } = tools;
  const { profile: _profile, ...pre006Tools } = version006Tools;
  return [
    version007,
    { ...version007, tools: version006Tools },
    { ...version007, tools: pre006Tools },
  ];
}

function relevantPolicyConfig(
  config: Record<string, unknown>,
  agentId: string,
): unknown {
  const gateway = record(config.gateway);
  const agents = record(config.agents);
  const endpoints = record(record(gateway?.http)?.endpoints);
  return {
    gateway: {
      auth: gateway?.auth,
      responses: record(endpoints?.responses),
      port: gateway?.port,
      tls: gateway?.tls,
    },
    agent: record(agents?.entries)?.[agentId],
  };
}

function canonicalHttpsOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("publicOrigin is required");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    value !== url.origin ||
    url.username ||
    url.password
  ) {
    throw new Error("publicOrigin must be a canonical HTTPS origin");
  }
  return value;
}

function modelIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9._:@/-]+$/.test(value) ||
    !value.includes("/")
  ) {
    throw new Error("model must be a provider/model identifier");
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(value)) {
    throw new Error(`${label} must match ^[a-z][a-z0-9-]{0,62}$`);
  }
  return value;
}

function port(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > 65_535
  ) {
    throw new Error(`${label} must be an integer from 1 through 65535`);
  }
  return Number(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function ensureRecord(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const existing = parent[key];
  if (existing === undefined) {
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  }
  const parsed = record(existing);
  if (!parsed) throw new Error(`${key} must be an object`);
  return parsed;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields`);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = record(value);
  if (object) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
