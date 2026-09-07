import { describe, expect, it } from "vitest";

import type { OpenClawPluginPolicyConfig } from "./contracts.js";
import { validateAgentConnectOpenResponsesPolicy } from "./application-policy.js";

const policy: OpenClawPluginPolicyConfig = {
  ref: "bookhand",
  label: "Bookhand",
  agentId: "bookhand",
  nativeCapabilities: [],
};

function config() {
  return {
    gateway: {
      roles: {
        definitions: {
          bookhand: {
            sessions: { others: "none" },
            agents: ["bookhand"],
            scopes: [],
            sandbox: "inherit",
          },
        },
      },
    },
    agents: {
      entries: {
        bookhand: {
          workspace: "/srv/openclaw-apps/bookhand",
          contextInjection: "never",
          tools: { deny: ["*"] },
        },
      },
    },
  };
}

describe("Agent Connect OpenResponses deployment recipe", () => {
  it("accepts the application-tools-only closed policy", () => {
    const cfg = config();
    Object.assign(cfg, { tools: { deny: ["*"] } });
    expect(validateAgentConnectOpenResponsesPolicy(cfg, policy)).toBe(true);
  });

  it("rejects media-adjacent policy widening and conditional native policy", () => {
    const widened = config();
    widened.agents.entries.bookhand.tools = {
      deny: [],
      allow: ["read"],
    } as never;
    expect(validateAgentConnectOpenResponsesPolicy(widened, policy)).toBe(
      false,
    );

    const conditional = config();
    Object.assign(conditional.agents.entries.bookhand.tools, {
      byProvider: { fixture: { allow: ["read"] } },
    });
    expect(validateAgentConnectOpenResponsesPolicy(conditional, policy)).toBe(
      false,
    );
  });

  it("requires native code capability to use exact tools and required sandbox", () => {
    const codePolicy = {
      ...policy,
      nativeCapabilities: ["sandbox_code_execution" as const],
    };
    const cfg = config();
    cfg.agents.entries.bookhand.tools = { allow: ["exec", "process"] } as never;
    expect(validateAgentConnectOpenResponsesPolicy(cfg, codePolicy)).toBe(
      false,
    );
    cfg.gateway.roles.definitions.bookhand.sandbox = "required";
    expect(validateAgentConnectOpenResponsesPolicy(cfg, codePolicy)).toBe(true);
  });
});
