import { createServer } from "node:http";

import { chromium, devices } from "@playwright/test";
import { expect, it } from "vitest";

import {
  ownerConsolePage,
  ownerLoginPage,
} from "../src/authorization/owner-html.js";

it("keeps the enrollment action visible near its content on a Pixel 7", async () => {
  const html = ownerLoginPage({
    action: "/agent-connect/owner/login",
    challenge: "preview-challenge",
    clientId: "https://reader.example",
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ...devices["Pixel 7"] });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    const layout = await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      );
      if (!button) throw new Error("missing Continue button");
      const bounds = button.getBoundingClientRect();
      return {
        buttonBottom: bounds.bottom,
        viewportHeight: window.visualViewport?.height ?? window.innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
      };
    });

    expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight);
    expect(layout.buttonBottom).toBeLessThan(layout.viewportHeight * 0.75);
    expect(
      await page.getByRole("button", { name: "Continue" }).isVisible(),
    ).toBe(true);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("keeps ten pending requests separated without horizontal overflow on a Pixel 7", async () => {
  const html = ownerConsolePage({
    grants: [],
    pending: Array.from({ length: 10 }, (_, index) => ({
      clientId: `https://application-${index + 1}.example`,
      requestUri: `urn:agent-connect:request:${index + 1}`,
      applicationToolNames: [`tool_${index + 1}`],
      expiresAt: new Date(Date.UTC(2026, 8, 16, 12, index)).toISOString(),
    })),
    authorizationPath: "/agent-connect/oauth/authorize",
    policies: [
      {
        label: "Reading and research",
        description: "A restricted profile for reading and research",
        agentId: "restricted-research-agent",
        nativeCapabilities: ["public_web_search"],
      },
    ],
    revokeAction: "/agent-connect/owner/grants/revoke",
    revokeAllAction: "/agent-connect/owner/grants/revoke-all",
    revokeAllCsrfToken: "revoke-all-csrf",
    forgetAction: "/agent-connect/owner/forget",
    forgetCsrfToken: "forget-csrf",
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ...devices["Pixel 7"] });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);

    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      recordCount: document.querySelectorAll(".access-record").length,
      sectionCount: document.querySelectorAll(".management-section").length,
      borderedSections: Array.from(
        document.querySelectorAll<HTMLElement>(".management-section"),
      ).every((section) => getComputedStyle(section).borderTopWidth === "1px"),
    }));

    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.recordCount).toBe(10);
    expect(layout.sectionCount).toBe(4);
    expect(layout.borderedSections).toBe(true);
    expect(
      await page.getByRole("link", { name: "Review request" }).count(),
    ).toBe(10);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
