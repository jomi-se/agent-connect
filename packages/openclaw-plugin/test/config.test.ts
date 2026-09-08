import { describe, expect, it } from "vitest";

import {
  applySetupMutation,
  inspectSetup,
  resolveSupportedRuntime,
  restrictedAgentConfig,
} from "../src/config.js";

const stateDir = "/tmp/agent-connect-plugin-test";
const requested = {
  publicOrigin: "https://gateway.example",
  agentId: "agent-connect-app",
};

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
    const preview = inspectSetup(config, requested, { stateDir });
    expect(preview).toMatchObject({ supported: true });
    expect(preview.changes).toEqual([
      "enable gateway.http.endpoints.responses",
      "add restricted agent agent-connect-app",
      "set plugins.entries.agent-connect.config",
    ]);

    applySetupMutation(config, requested, stateDir);
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
    expect(inspectSetup(config, requested, { stateDir })).toMatchObject({
      supported: true,
      changes: [],
      errors: [],
    });
  });

  it("refuses an existing conflicting agent without overwriting it", () => {
    const config = representativeConfig();
    (
      (config.agents as Record<string, unknown>).entries as Record<
        string,
        unknown
      >
    )[requested.agentId] = { workspace: "/tmp/user-owned" };
    const inspection = inspectSetup(config, requested, { stateDir });
    expect(inspection.supported).toBe(false);
    expect(inspection.errors[0]).toContain("already exists");
    expect(() => applySetupMutation(config, requested, stateDir)).toThrow(
      "already exists",
    );
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
    const inspection = inspectSetup(config, requested, { stateDir });
    expect(inspection).toMatchObject({ supported: true, errors: [] });
    expect(entries["third-party-hooks"]).toEqual({ enabled: true });
  });

  it("ignores unrelated personal-agent changes but fingerprints relevant policy", () => {
    const config = representativeConfig();
    applySetupMutation(config, requested, stateDir);
    const initial = resolveSupportedRuntime(config, requested, { stateDir });
    const entries = (config.agents as Record<string, unknown>)
      .entries as Record<string, unknown>;
    entries.personal = { workspace: "/tmp/changed-personal" };
    expect(
      resolveSupportedRuntime(config, requested, { stateDir }).fingerprint,
    ).toBe(initial.fingerprint);
    (
      ((config.plugins as Record<string, unknown>).entries ?? {}) as Record<
        string,
        unknown
      >
    )["owner-installed"] = { enabled: true };
    config.hooks = { enabled: true };
    expect(
      resolveSupportedRuntime(config, requested, { stateDir }).fingerprint,
    ).toBe(initial.fingerprint);
    entries[requested.agentId] = {
      ...restrictedAgentConfig(stateDir),
      skills: ["unsafe-skill"],
    };
    expect(() =>
      resolveSupportedRuntime(config, requested, { stateDir }),
    ).toThrow("restricted recipe");
  });

  it("rejects password and unresolved gateway authentication", () => {
    const config = representativeConfig();
    applySetupMutation(config, requested, stateDir);
    (config.gateway as Record<string, unknown>).auth = {
      mode: "password",
      password: "not-used",
    };
    expect(() =>
      resolveSupportedRuntime(config, requested, { stateDir }),
    ).toThrow("password and SecretRef");
  });
});
