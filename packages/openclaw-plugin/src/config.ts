import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { OfferedDelegatedPolicy } from "../../gateway/src/delegated-grants.js";

export const PLUGIN_ID = "agent-connect";
export const DEFAULT_AGENT_ID = "agent-connect-app";
export const POLICY_REF = "application-tools-only";

export interface StockPluginConfig {
  readonly publicOrigin: string;
  readonly agentId: string;
}

export interface SupportedRuntime {
  readonly publicOrigin: string;
  readonly issuer: string;
  readonly resource: string;
  readonly agentId: string;
  readonly upstreamBaseUrl: string;
  readonly upstreamToken: string;
  readonly fingerprint: string;
  readonly policy: OfferedDelegatedPolicy;
}

export interface SetupInspection {
  readonly supported: boolean;
  readonly changes: readonly string[];
  readonly errors: readonly string[];
  readonly config: StockPluginConfig;
}

export function parsePluginConfig(value: unknown): StockPluginConfig {
  const input = record(value);
  if (!input) throw new Error("Agent Connect setup has not been applied");
  exactKeys(input, ["publicOrigin", "agentId"], "plugin config");
  return {
    publicOrigin: canonicalHttpsOrigin(input.publicOrigin),
    agentId: identifier(input.agentId, "agentId"),
  };
}

export function inspectSetup(
  value: unknown,
  requested: StockPluginConfig,
  options: {
    readonly stateDir: string;
  },
): SetupInspection {
  const config = record(value) ?? {};
  const changes: string[] = [];
  const errors: string[] = [];
  const gateway = record(config.gateway) ?? {};
  const http = record(gateway.http) ?? {};
  const endpoints = record(http.endpoints) ?? {};
  const responses = record(endpoints.responses) ?? {};
  if (responses.enabled !== true)
    changes.push("enable gateway.http.endpoints.responses");

  const agents = record(config.agents) ?? {};
  const entries = record(agents.entries) ?? {};
  const existingAgent = entries[requested.agentId];
  const expectedAgent = restrictedAgentConfig(options.stateDir);
  if (existingAgent === undefined) {
    changes.push(`add restricted agent ${requested.agentId}`);
  } else if (!sameJson(existingAgent, expectedAgent)) {
    errors.push(
      `agents.entries.${requested.agentId} already exists and is not the Agent Connect restricted recipe`,
    );
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
    config: requested,
  };
}

export function applySetupMutation(
  draft: Record<string, unknown>,
  requested: StockPluginConfig,
  stateDir: string,
): void {
  const inspection = inspectSetup(draft, requested, { stateDir });
  if (!inspection.supported) throw new Error(inspection.errors.join("; "));

  const gateway = ensureRecord(draft, "gateway");
  const http = ensureRecord(gateway, "http");
  const endpoints = ensureRecord(http, "endpoints");
  const responses = ensureRecord(endpoints, "responses");
  responses.enabled = true;

  const agents = ensureRecord(draft, "agents");
  const entries = ensureRecord(agents, "entries");
  entries[requested.agentId] ??= restrictedAgentConfig(stateDir);

  const plugins = ensureRecord(draft, "plugins");
  const pluginEntries = ensureRecord(plugins, "entries");
  const ownEntry = ensureRecord(pluginEntries, PLUGIN_ID);
  ownEntry.enabled = true;
  ownEntry.config = { ...requested };
}

export function resolveSupportedRuntime(
  value: unknown,
  pluginConfig: StockPluginConfig,
  options: {
    readonly stateDir: string;
  },
): SupportedRuntime {
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
  const gateway = record(config.gateway) as Record<string, unknown>;
  const auth = record(gateway.auth);
  if (auth?.mode !== "token" || typeof auth.token !== "string" || !auth.token) {
    throw new Error(
      "Agent Connect supports only a resolved literal gateway token; password and SecretRef auth are unsupported",
    );
  }
  if (record(gateway.tls)?.enabled === true) {
    throw new Error("native gateway TLS on the local listener is unsupported");
  }
  const port = gateway.port;
  if (
    !Number.isSafeInteger(port) ||
    Number(port) < 1 ||
    Number(port) > 65_535
  ) {
    throw new Error("gateway.port must be an explicit TCP port");
  }
  const issuer = `${pluginConfig.publicOrigin}/agent-connect`;
  const resource = `${issuer}/v1/responses`;
  const relevant = relevantPolicyConfig(config, pluginConfig.agentId);
  const fingerprint = `sha256:${createHash("sha256")
    .update(canonicalJson({ pluginConfig, relevant }))
    .digest("hex")}`;
  return {
    publicOrigin: pluginConfig.publicOrigin,
    issuer,
    resource,
    agentId: pluginConfig.agentId,
    upstreamBaseUrl: `http://127.0.0.1:${port}`,
    upstreamToken: auth.token,
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
}

export function restrictedAgentConfig(
  stateDir: string,
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
    tools: { deny: ["*"], elevated: { enabled: false } },
  };
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

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(value)) {
    throw new Error(`${label} must match ^[a-z][a-z0-9-]{0,62}$`);
  }
  return value;
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
