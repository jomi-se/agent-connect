import { describe, expect, it } from "vitest";

import {
  consentPage,
  ownerConsolePage,
  ownerLoginPage,
} from "../src/authorization/owner-html.js";

describe("owner HTML", () => {
  it("escapes untrusted labels while keeping authority classes distinct", () => {
    const html = consentPage({
      clientId: "https://reader.example",
      action: "/agent-connect/oauth/authorize",
      requestUri: "request-uri",
      csrfToken: "csrf-token",
      tools: ["tool<unsafe>"],
      defaultPolicyIndex: 0,
      policies: [
        {
          label: "Profile <unsafe>",
          description: 'Description "unsafe"',
          nativeCapabilities: ["public_web_search"],
        },
      ],
    });

    expect(html).toContain("tool&lt;unsafe&gt;");
    expect(html).toContain("Profile &lt;unsafe&gt;");
    expect(html).not.toContain("tool<unsafe>");
    expect(html).toContain("Application tools");
    expect(html).toContain("Native OpenClaw capabilities");
  });

  it("does not invent a last-use field in the owner console", () => {
    const html = ownerConsolePage({
      grants: [],
      pending: [],
      authorizationPath: "/agent-connect/oauth/authorize",
      policies: [],
      revokeAction: "/agent-connect/owner/grants/revoke",
      revokeAllAction: "/agent-connect/owner/grants/revoke-all",
      revokeAllCsrfToken: "revoke-all-csrf",
      forgetAction: "/agent-connect/owner/forget",
      forgetCsrfToken: "forget-csrf",
    });
    expect(html).toContain("No active application access");
    expect(html).toContain('class="management-section');
    expect(html).toContain('aria-label="0 pending requests"');
    expect(html.toLowerCase()).not.toContain("last use");
  });

  it("does not repeat the product identity on owner-only pages", () => {
    const consoleHtml = ownerConsolePage({
      grants: [],
      pending: [],
      authorizationPath: "/agent-connect/oauth/authorize",
      policies: [],
      revokeAction: "/agent-connect/owner/grants/revoke",
      revokeAllAction: "/agent-connect/owner/grants/revoke-all",
      revokeAllCsrfToken: "revoke-all-csrf",
      forgetAction: "/agent-connect/owner/forget",
      forgetCsrfToken: "forget-csrf",
    });
    const loginHtml = ownerLoginPage({
      action: "/agent-connect/owner/login",
      challenge: "challenge",
    });

    expect(consoleHtml.match(/>Agent Connect</g)).toHaveLength(1);
    expect(loginHtml.match(/>Agent Connect</g)).toHaveLength(1);
    expect(consoleHtml).toContain(
      "<span></span><span></span><span></span></span>Agent Connect",
    );
    expect(loginHtml).toContain("Owner sign-in");
  });

  it("keeps browser forgetting separate from revoking application grants", () => {
    const html = ownerConsolePage({
      grants: [],
      pending: [],
      authorizationPath: "/agent-connect/oauth/authorize",
      policies: [],
      revokeAction: "/agent-connect/owner/grants/revoke",
      revokeAllAction: "/agent-connect/owner/grants/revoke-all",
      revokeAllCsrfToken: "revoke-all-csrf",
      forgetAction: "/agent-connect/owner/forget",
      forgetCsrfToken: "forget-csrf",
    });

    expect(html).toContain("Forget this browser");
    expect(html).toContain("Application grants remain active");
    expect(html).toContain("Revoke all active grants");
    expect(html).toContain('action="/agent-connect/owner/forget"');
    expect(html).toContain('action="/agent-connect/owner/grants/revoke-all"');
  });
});
