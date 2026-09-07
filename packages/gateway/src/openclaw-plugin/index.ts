import type { IncomingMessage, ServerResponse } from "node:http";

import { authenticateVerifiedPluginHttpPrincipal } from "openclaw/plugin-sdk/authenticated-http-principal";
import { fingerprintOpenResponsesApplicationPolicy } from "openclaw/plugin-sdk/openresponses-application-policy";

import { DelegatedGrantService } from "../delegated-grants.js";
import { createOpenResponsesApplicationAuthProvider } from "./application-auth.js";
import { validateAgentConnectOpenResponsesPolicy } from "./application-policy.js";
import {
  OPENCLAW_PLUGIN_ID,
  toOfferedPolicy,
  type HostPluginApi,
  type OpenClawPluginConfig,
  type OpenClawPluginPolicyConfig,
} from "./contracts.js";
import { OpenClawOAuthHandler } from "./oauth-handler.js";

const PUBLIC_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/agent-connect/oauth/par",
  "/agent-connect/oauth/token",
  "/agent-connect/oauth/revoke",
] as const;

export { createOpenResponsesApplicationAuthProvider } from "./application-auth.js";
export * from "./contracts.js";
export { OpenClawOAuthHandler } from "./oauth-handler.js";

export default {
  id: OPENCLAW_PLUGIN_ID,
  register(api: HostPluginApi): void {
    const config = parsePluginConfig(api.pluginConfig);
    const offeredPolicies = config.policies.map((policy) => {
      if (!validateAgentConnectOpenResponsesPolicy(api.config, policy)) {
        throw new Error(
          `Agent Connect policy ${policy.ref} does not match the closed recipe`,
        );
      }
      const fingerprint = fingerprintOpenResponsesApplicationPolicy(
        api.config,
        { policyRef: policy.ref },
      );
      if (!fingerprint) {
        throw new Error(
          `Agent Connect policy ${policy.ref} is unavailable to native admission`,
        );
      }
      return toOfferedPolicy(policy, fingerprint);
    });
    const grantService = new DelegatedGrantService({
      resource: config.resource,
      offeredPolicies,
      statePath: config.statePath,
    });
    const oauth = new OpenClawOAuthHandler({
      issuer: config.issuer,
      resource: config.resource,
      grantService,
      allowedOwnerProfileIds: config.ownerProfileIds,
      ownerVerifier: (request) =>
        authenticateVerifiedPluginHttpPrincipal(request, {
          authMethods: ["tailscale"],
        }),
    });
    const handler = async (request: unknown, response: unknown) =>
      oauth.handle(request as IncomingMessage, response as ServerResponse);

    for (const path of PUBLIC_PATHS) {
      api.registerHttpRoute({ path, auth: "plugin", match: "exact", handler });
    }
    api.registerHttpRoute({
      path: "/agent-connect/oauth/authorize",
      auth: "plugin",
      match: "exact",
      handler,
    });
    api.registerOpenResponsesApplicationAuth(
      createOpenResponsesApplicationAuthProvider({
        resource: config.resource,
        grantService,
      }),
    );
  },
};

function parsePluginConfig(value: unknown): OpenClawPluginConfig {
  const config = requireRecord(value, "plugin config");
  requireExactKeys(config, [
    "issuer",
    "resource",
    "statePath",
    "ownerProfileIds",
    "policies",
  ]);
  const ownerProfileIds = requireStringArray(
    config.ownerProfileIds,
    "ownerProfileIds",
  );
  const policies = requireArray(config.policies, "policies").map((policy) =>
    parsePolicy(policy),
  );
  if (ownerProfileIds.length === 0 || policies.length === 0) {
    throw new Error("ownerProfileIds and policies must not be empty");
  }
  if (!policies.some((policy) => policy.nativeCapabilities.length === 0)) {
    throw new Error("an application-tools-only policy must be configured");
  }
  return {
    issuer: requireString(config.issuer, "issuer"),
    resource: requireString(config.resource, "resource"),
    statePath: requireString(config.statePath, "statePath"),
    ownerProfileIds,
    policies,
  };
}

function parsePolicy(value: unknown): OpenClawPluginPolicyConfig {
  const policy = requireRecord(value, "policy");
  requireExactKeys(policy, [
    "ref",
    "label",
    "description",
    "agentId",
    "nativeCapabilities",
  ]);
  const nativeCapabilities = requireStringArray(
    policy.nativeCapabilities,
    "nativeCapabilities",
  );
  for (const capability of nativeCapabilities) {
    if (
      capability !== "public_web_search" &&
      capability !== "sandbox_code_execution"
    ) {
      throw new Error("unsupported native capability");
    }
  }
  const description = policy.description;
  if (description !== undefined && typeof description !== "string") {
    throw new Error("description must be a string");
  }
  return {
    ref: requireString(policy.ref, "ref"),
    label: requireString(policy.label, "label"),
    ...(description ? { description } : {}),
    agentId: requireString(policy.agentId, "agentId"),
    nativeCapabilities,
  } as OpenClawPluginPolicyConfig;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw new Error("unknown plugin configuration field");
  }
}

function requireString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  return requireArray(value, label).map((item) => requireString(item, label));
}
