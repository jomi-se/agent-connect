import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadStaticOpenClawPolicy } from "../src/scoped-proxy/policy.js";

describe("static stock OpenClaw policy contract", () => {
  it("accepts a closed app-only agent and invalidates its snapshot on any edit", () => {
    const fixture = files(config(), policies([]));
    const snapshot = loadStaticOpenClawPolicy({
      ...fixture,
      upstreamToken: "operator-secret",
      upstreamBaseUrl: "http://127.0.0.1:18789",
    });
    expect(snapshot.offeredPolicies).toMatchObject([
      {
        ref: "application-tools-only",
        agentId: "restricted",
        nativeCapabilities: [],
      },
    ]);
    expect(() => snapshot.assertUnchanged()).not.toThrow();
    expect(() =>
      snapshot.assertRuntimeConfig(
        config({ gatewayToken: "__OPENCLAW_REDACTED__" }),
      ),
    ).not.toThrow();
    const bound = snapshot.withRuntimeVerifier({
      appliedConfigHash: "stock-applied-revision",
      async assertCurrent() {},
    });
    expect(bound.offeredPolicies[0]?.fingerprint).not.toBe(
      snapshot.offeredPolicies[0]?.fingerprint,
    );
    writePrivate(fixture.policyPath, `${JSON.stringify(policies([]))}\n`);
    expect(() => snapshot.assertUnchanged()).toThrow(/restart and reconsent/);
  });

  it("requires disabled elevation/tool-search and exact capability tools", () => {
    expect(() => load(config({ elevated: true }), policies([]))).toThrow(
      /tool search, elevation/,
    );
    expect(() =>
      load(config({ allow: ["web_search", "exec"] }), policies([])),
    ).toThrow(/deny/);
    expect(() =>
      load(
        config({
          allow: ["exec", "process"],
          sandbox: {
            mode: "all",
            backend: "docker",
            scope: "session",
            workspaceAccess: "ro",
            docker: { network: "none", binds: [] },
          },
        }),
        policies(["sandbox_code_execution"]),
      ),
    ).not.toThrow();
    expect(() =>
      load(
        config({
          allow: ["exec", "process"],
          sandbox: {
            mode: "all",
            backend: "docker",
            scope: "session",
            workspaceAccess: "rw",
          },
        }),
        policies(["sandbox_code_execution"]),
      ),
    ).toThrow(/sandbox|docker/);
    expect(() =>
      load(
        config({
          allow: ["exec", "process"],
          sandbox: {
            mode: "all",
            backend: "docker",
            scope: "session",
            workspaceAccess: "ro",
            docker: { binds: [] },
          },
        }),
        policies(["sandbox_code_execution"]),
      ),
    ).toThrow(/no-egress container sandbox/);
  });

  it("rejects fields outside the narrow execution template", () => {
    const value = config() as Record<string, unknown>;
    value.models = { providers: {} };
    expect(() => load(value, policies([]))).toThrow(
      /root contains unsupported fields: models/,
    );
    const agent = (
      value.agents as { entries: Record<string, Record<string, unknown>> }
    ).entries.restricted as Record<string, unknown>;
    delete value.models;
    agent.subagents = { allowAgents: ["*"] };
    expect(() => load(value, policies([]))).toThrow(
      /contains unsupported fields: subagents/,
    );
  });
});

function load(configValue: unknown, policyValue: unknown) {
  const fixture = files(configValue, policyValue);
  return loadStaticOpenClawPolicy({
    ...fixture,
    upstreamToken: "operator-secret",
    upstreamBaseUrl: "http://127.0.0.1:18789",
  });
}

function files(configValue: unknown, policyValue: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "ac-policy-test-"));
  const configPath = join(directory, "openclaw.json");
  const policyPath = join(directory, "policies.json");
  writePrivate(configPath, JSON.stringify(configValue));
  writePrivate(policyPath, JSON.stringify(policyValue));
  return { configPath, policyPath };
}

function writePrivate(path: string, value: string) {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function config(
  changes: {
    elevated?: boolean;
    allow?: string[];
    sandbox?: Record<string, unknown>;
    gatewayToken?: string;
  } = {},
) {
  return {
    gateway: {
      mode: "local",
      bind: "loopback",
      port: 18789,
      auth: {
        mode: "token",
        token: changes.gatewayToken ?? "operator-secret",
      },
      reload: { mode: "off" },
      http: { endpoints: { responses: { enabled: true } } },
    },
    tools: {
      toolSearch: false,
      elevated: { enabled: changes.elevated ?? false },
    },
    agents: {
      defaults: {
        skipBootstrap: true,
        heartbeat: { every: "0m" },
        timeoutSeconds: 90,
        models: {
          "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
        },
      },
      entries: {
        restricted: {
          workspace: "/tmp/restricted-agent",
          contextInjection: "never",
          model: { primary: "openai/gpt-5.6-sol", fallbacks: [] },
          skills: [],
          memory: { search: { enabled: false } },
          tools: changes.allow ? { allow: changes.allow } : { deny: ["*"] },
          ...(changes.sandbox ? { sandbox: changes.sandbox } : {}),
        },
      },
    },
    plugins: {
      slots: { memory: "none" },
      entries: { "memory-core": { enabled: false } },
    },
    auth: {
      profiles: {
        "openai:default": { provider: "openai", mode: "oauth" },
      },
      order: { openai: ["openai:default"] },
    },
  };
}

function policies(nativeCapabilities: string[]) {
  return {
    version: 1,
    policies: [
      {
        ref: "application-tools-only",
        label: "Application tools only",
        agentId: "restricted",
        nativeCapabilities,
      },
    ],
  };
}
