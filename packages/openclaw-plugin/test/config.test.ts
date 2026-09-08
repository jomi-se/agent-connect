import { describe, expect, it } from "vitest";

import {
  applySetupMutation,
  inspectSetup,
  resolveSupportedRuntime,
  restrictedAgentConfig,
  setupReadiness,
  type GatewayAuthResolver,
} from "../src/config.js";

const stateDir = "/tmp/agent-connect-plugin-test";
const requested = {
  publicOrigin: "https://gateway.example",
  agentId: "agent-connect-app",
};
const resolveGatewayAuth: GatewayAuthResolver = ({ authConfig }) => {
  const mode = authConfig?.mode ?? "token";
  return {
    mode,
    ...(mode === "token" && typeof authConfig?.token === "string"
      ? { token: authConfig.token }
      : {}),
    ...(mode === "password" && typeof authConfig?.password === "string"
      ? { password: authConfig.password }
      : {}),
  };
};
const inspectionOptions = { stateDir, resolveGatewayAuth };

function representativeConfig(): Record<string, unknown> {
  return {
    gateway: {
      mode: "local",
      bind: "loopback",
      port: 18789,
      auth: { mode: "token", token: "operator-secret" },
      http: { endpoints: { responses: { enabled: false } } },
    },
    agents: {
      defaults: {
        workspace: "/tmp/personal-workspace",
        skills: ["personal-skill"],
      },
      entries: {
        personal: {
          name: "Personal agent",
          workspace: "/tmp/personal-agent",
          tools: { allow: ["web_search"] },
        },
      },
    },
    channels: { telegram: { enabled: true } },
    memory: { search: { enabled: true } },
    tools: { allow: ["web_search", "exec"] },
    plugins: {
      allow: ["agent-connect", "memory-core", "disabled-example"],
      slots: { memory: "memory-core" },
      entries: {
        "agent-connect": { enabled: true },
        "memory-core": { enabled: true },
        "disabled-example": { enabled: false },
      },
    },
  };
}

describe("stock OpenClaw plugin configuration", () => {
  it("adds only the namespaced agent, Responses flag, and plugin config", () => {
    const config = representativeConfig();
    const beforePersonal = structuredClone({
      personal: (config.agents as Record<string, unknown>).entries,
      channels: config.channels,
      memory: config.memory,
      tools: config.tools,
    });
    const preview = inspectSetup(config, requested, inspectionOptions);
    expect(preview).toMatchObject({ supported: true });
    expect(preview.changes).toEqual([
      "enable gateway.http.endpoints.responses",
      "add restricted agent agent-connect-app",
      "set plugins.entries.agent-connect.config",
    ]);
    expect(setupReadiness(preview, true)).toEqual({
      ok: false,
      status: "setup_required",
    });

    applySetupMutation(config, requested, stateDir, resolveGatewayAuth);
    expect(
      (
        (config.gateway as Record<string, unknown>).http as Record<
          string,
          unknown
        >
      ).endpoints,
    ).toEqual({ responses: { enabled: true } });
    expect(
      (
        (config.agents as Record<string, unknown>).entries as Record<
          string,
          unknown
        >
      )[requested.agentId],
    ).toEqual(restrictedAgentConfig(stateDir));
    expect({
      personal: (config.agents as Record<string, unknown>).entries,
      channels: config.channels,
      memory: config.memory,
      tools: config.tools,
    }).toMatchObject(beforePersonal);
    expect(inspectSetup(config, requested, inspectionOptions)).toMatchObject({
      supported: true,
      changes: [],
      errors: [],
      warnings: [],
    });
    expect(
      resolveSupportedRuntime(config, requested, inspectionOptions),
    ).toMatchObject({
      upstreamBaseUrl: "http://127.0.0.1:18789",
      upstreamAuth: { mode: "token", credential: "operator-secret" },
    });
    expect(
      setupReadiness(inspectSetup(config, requested, inspectionOptions), false),
    ).toEqual({ ok: false, status: "owner_identity_missing" });
    expect(
      setupReadiness(inspectSetup(config, requested, inspectionOptions), true),
    ).toEqual({ ok: true, status: "ready" });
  });

  it("refuses an existing conflicting agent without overwriting it", () => {
    const config = representativeConfig();
    (
      (config.agents as Record<string, unknown>).entries as Record<
        string,
        unknown
      >
    )[requested.agentId] = { workspace: "/tmp/user-owned" };
    const inspection = inspectSetup(config, requested, inspectionOptions);
    expect(inspection.supported).toBe(false);
    expect(inspection.errors[0]).toContain("already exists");
    expect(() =>
      applySetupMutation(config, requested, stateDir, resolveGatewayAuth),
    ).toThrow("already exists");
  });

  it("preserves owner-installed plugins and hooks inside the trusted host", () => {
    const config = representativeConfig();
    const entries = ((config.plugins as Record<string, unknown>).entries ??
      {}) as Record<string, unknown>;
    entries["third-party-hooks"] = { enabled: true };
    (config.plugins as Record<string, unknown>).load = {
      paths: ["/opt/owner/openclaw-plugins"],
    };
    config.hooks = { enabled: true, allowedAgentIds: ["*"] };
    const inspection = inspectSetup(config, requested, inspectionOptions);
    expect(inspection).toMatchObject({ supported: true, errors: [] });
    expect(entries["third-party-hooks"]).toEqual({ enabled: true });
  });

  it("ignores unrelated personal-agent changes but fingerprints relevant policy", () => {
    const config = representativeConfig();
    applySetupMutation(config, requested, stateDir, resolveGatewayAuth);
    const initial = resolveSupportedRuntime(
      config,
      requested,
      inspectionOptions,
    );
    const entries = (config.agents as Record<string, unknown>)
      .entries as Record<string, unknown>;
    entries.personal = { workspace: "/tmp/changed-personal" };
    expect(
      resolveSupportedRuntime(config, requested, inspectionOptions).fingerprint,
    ).toBe(initial.fingerprint);
    (
      ((config.plugins as Record<string, unknown>).entries ?? {}) as Record<
        string,
        unknown
      >
    )["owner-installed"] = { enabled: true };
    config.hooks = { enabled: true };
    expect(
      resolveSupportedRuntime(config, requested, inspectionOptions).fingerprint,
    ).toBe(initial.fingerprint);
    entries[requested.agentId] = {
      ...restrictedAgentConfig(stateDir),
      skills: ["unsafe-skill"],
    };
    expect(() =>
      resolveSupportedRuntime(config, requested, inspectionOptions),
    ).toThrow("restricted recipe");
  });

  it("supports resolved password authentication", () => {
    const config = representativeConfig();
    (config.gateway as Record<string, unknown>).auth = {
      mode: "password",
      password: "operator-password",
    };
    applySetupMutation(config, requested, stateDir, resolveGatewayAuth);
    expect(
      resolveSupportedRuntime(config, requested, inspectionOptions),
    ).toMatchObject({
      upstreamAuth: {
        mode: "password",
        credential: "operator-password",
      },
    });
  });

  it("rejects unresolved password authentication without mutating setup", () => {
    const config = representativeConfig();
    (config.gateway as Record<string, unknown>).auth = {
      mode: "password",
      password: {
        source: "env",
        provider: "default",
        id: "OPENCLAW_GATEWAY_PASSWORD",
      },
    };
    const before = structuredClone(config);
    const inspection = inspectSetup(config, requested, inspectionOptions);
    expect(inspection.supported).toBe(false);
    expect(inspection.errors).toContain(
      "gateway.auth.password is configured but its credential is unavailable to the active host runtime",
    );
    expect(() =>
      applySetupMutation(config, requested, stateDir, resolveGatewayAuth),
    ).toThrow("credential is unavailable");
    expect(config).toEqual(before);
    expect(setupReadiness(inspection, false)).toEqual({
      ok: false,
      status: "unsupported_host",
    });
  });

  it("rejects native TLS and an invalid gateway port during preflight", () => {
    const config = representativeConfig();
    const gateway = config.gateway as Record<string, unknown>;
    gateway.tls = { enabled: true };
    gateway.port = 65_536;
    const inspection = inspectSetup(config, requested, inspectionOptions);
    expect(inspection.supported).toBe(false);
    expect(inspection.errors).toEqual([
      "gateway.tls.enabled must not be true; terminate public HTTPS outside the loopback listener",
      "gateway.port must be an explicit integer from 1 through 65535",
    ]);
  });

  it("supports explicit no-auth upstream while warning about native routes", () => {
    const config = representativeConfig();
    (config.gateway as Record<string, unknown>).auth = { mode: "none" };
    applySetupMutation(config, requested, stateDir, resolveGatewayAuth);
    const inspection = inspectSetup(config, requested, inspectionOptions);
    expect(inspection).toMatchObject({
      supported: true,
      changes: [],
      errors: [],
    });
    expect(inspection.warnings.join(" ")).toContain(
      "native endpoints outside /agent-connect are not protected",
    );
    expect(
      resolveSupportedRuntime(config, requested, inspectionOptions),
    ).toMatchObject({
      upstreamAuth: { mode: "none" },
    });
  });
});
