import type { OpenClawPluginPolicyConfig } from "./contracts.js";

const CAPABILITY_TO_NATIVE_TOOLS = {
  public_web_search: ["web_search"],
  sandbox_code_execution: ["exec", "process"],
} as const;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value.map((entry) => entry.trim()).filter(Boolean)
    : undefined;
}

function exactEntries(value: unknown, expected: readonly string[]): boolean {
  const entries = strings(value);
  return (
    entries !== undefined &&
    [...new Set(entries)].sort().join("\0") === [...expected].sort().join("\0")
  );
}

function rejectsConditionalPolicy(policy: RecordValue | undefined): boolean {
  return Boolean(
    policy &&
    (policy.alsoAllow !== undefined ||
      policy.profile !== undefined ||
      policy.byProvider !== undefined ||
      policy.toolsBySender !== undefined),
  );
}

/**
 * Agent Connect's deliberately narrow deployment recipe. This is stricter than
 * OpenClaw's general tool matcher: it accepts no conditional or wildcard policy
 * syntax, so this plugin never becomes a second permissive policy interpreter.
 */
export function validateAgentConnectOpenResponsesPolicy(
  value: unknown,
  policy: OpenClawPluginPolicyConfig,
): boolean {
  const config = record(value);
  const gateway = record(config?.gateway);
  const roles = record(gateway?.roles);
  const definitions = record(roles?.definitions);
  const role = record(definitions?.[policy.ref]);
  const sessions = record(role?.sessions);
  const roleAgents = strings(role?.agents);
  const scopes = strings(role?.scopes);
  if (
    sessions?.others !== "none" ||
    roleAgents?.length !== 1 ||
    roleAgents[0] !== policy.agentId ||
    !scopes ||
    scopes.includes("operator.admin")
  ) {
    return false;
  }

  const agents = record(config?.agents);
  const entries = record(agents?.entries);
  const list = Array.isArray(agents?.list) ? agents.list : [];
  const agent =
    record(entries?.[policy.agentId]) ??
    list.map(record).find((candidate) => candidate?.id === policy.agentId);
  const agentTools = record(agent?.tools);
  if (
    !agent ||
    (typeof agent.workspace !== "string" && typeof agent.cwd !== "string") ||
    agent.contextInjection !== "never" ||
    !agentTools ||
    rejectsConditionalPolicy(agentTools)
  ) {
    return false;
  }

  const expectedTools = [
    ...new Set(
      policy.nativeCapabilities.flatMap(
        (capability) => CAPABILITY_TO_NATIVE_TOOLS[capability],
      ),
    ),
  ].sort();
  if (
    expectedTools.length === 0
      ? !exactEntries(agentTools.deny, ["*"]) ||
        strings(agentTools.allow)?.length
      : !exactEntries(agentTools.allow, expectedTools) ||
        strings(agentTools.deny)?.length
  ) {
    return false;
  }
  if (
    policy.nativeCapabilities.includes("sandbox_code_execution") &&
    role?.sandbox !== "required"
  ) {
    return false;
  }
  // The exact agent-local deny-all is already the app-only ceiling. More
  // restrictive global/sandbox layers cannot widen it and are valid defaults.
  if (expectedTools.length === 0) return true;

  const globalTools = record(config?.tools);
  const policyLayers = [
    globalTools,
    record(record(globalTools?.sandbox)?.tools),
    record(record(agentTools.sandbox)?.tools),
  ];
  return policyLayers.every((layer) => {
    if (!layer) return true;
    if (
      rejectsConditionalPolicy(layer) ||
      (strings(layer.deny)?.length ?? 0) > 0
    )
      return false;
    const allow = strings(layer.allow);
    return (
      allow === undefined || expectedTools.every((tool) => allow.includes(tool))
    );
  });
}
