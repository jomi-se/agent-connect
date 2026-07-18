import { expect, test } from "@playwright/test";

test("the dynamically defined tool writes an agent message onto the page", async ({
  page,
}) => {
  const postedEvents: unknown[] = [];
  await page.route("https://gateway.example/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/app-sessions") {
      expect(request.headers()["authorization"]).toBe("Bearer existing-grant");
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: "acs-canvas",
          accessToken: "scoped-token",
          expiresAt: "2099-01-01T00:00:00.000Z",
          toolHash: "tool-hash",
        }),
      });
      return;
    }
    if (request.method() === "GET") {
      await route.fulfill({
        contentType: "text/event-stream",
        body: [
          sse({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              status: "action_required",
              call_id: "call-canvas-1",
              name: "set_page_message",
              arguments: JSON.stringify({ message: "Hello from your Codex." }),
            },
          }),
          sse({ type: "response.output_text.delta", delta: "Canvas updated." }),
          sse({ type: "response.completed" }),
        ].join(""),
      });
      return;
    }
    postedEvents.push(request.postDataJSON());
    await route.fulfill({ status: 202, body: "{}" });
  });

  await page.goto("/");
  await page.evaluate(() => {
    sessionStorage.setItem("agent-connect.grant", "existing-grant");
  });
  await page.reload();
  await page.locator("#runtime-card").fill(
    JSON.stringify({
      version: 1,
      runtimeId: "sha256:test",
      endpoint: "https://gateway.example",
      connectorPublicKey: {},
      transportProfile: "tailscale-serve",
      authorizationServer: "https://gateway.example",
    }),
  );
  await page.getByRole("button", { name: "Run with my Codex" }).click();

  await expect(page.locator("body")).toHaveAttribute("data-demo", "passed");
  await expect(page.locator("#canvas-message")).toHaveText(
    "Hello from your Codex.",
  );
  await expect(page.locator("#canvas-message")).toHaveAttribute(
    "data-agent-writes",
    "1",
  );
  expect(postedEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "message",
        tools: [
          expect.objectContaining({
            function: expect.objectContaining({ name: "set_page_message" }),
          }),
        ],
      }),
      expect.objectContaining({
        type: "function_call_output",
        data: { call_id: "call-canvas-1", output: expect.any(String) },
      }),
    ]),
  );
});

test("a revoked grant is cleared so the user can authorize again", async ({
  page,
}) => {
  let challengeRequests = 0;
  await page.route("https://gateway.example/v1/app-sessions", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "invalid_app_grant" }),
    });
  });
  await page.route(
    "https://gateway.example/v1/runtime-challenges",
    async (route) => {
      challengeRequests += 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "fixture_stops_after_challenge" }),
      });
    },
  );

  await page.goto("/");
  await page.evaluate(() => {
    sessionStorage.setItem("agent-connect.grant", "revoked-grant");
  });
  await page.reload();
  await page.locator("#runtime-card").fill(
    JSON.stringify({
      version: 1,
      runtimeId: "sha256:test",
      endpoint: "https://gateway.example",
      connectorPublicKey: {},
      transportProfile: "public-demo",
      authorizationServer: "https://gateway.example",
    }),
  );

  await expect(
    page.getByRole("button", { name: "Disconnect agent" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Run with my Codex" }).click();

  await expect(page.locator("body")).toHaveAttribute(
    "data-demo",
    "reauthorize",
  );
  await expect(page.locator("#status")).toHaveText(
    "Authorization was revoked or expired. Run again to reconnect.",
  );
  await expect(
    page.getByRole("button", { name: "Disconnect agent" }),
  ).toBeHidden();
  expect(
    await page.evaluate(() => sessionStorage.getItem("agent-connect.grant")),
  ).toBeNull();

  await page.getByRole("button", { name: "Run with my Codex" }).click();
  await expect.poll(() => challengeRequests).toBe(1);
});

test("disconnect clears the local grant", async ({ page }) => {
  let revoked = false;
  await page.route("https://gateway.example/oauth/revoke", async (route) => {
    expect(route.request().headers()["authorization"]).toBe(
      "Bearer existing-grant",
    );
    expect(route.request().postDataJSON()).toEqual({
      appId: "agent-connect-demo",
    });
    revoked = true;
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/");
  await page.evaluate(() => {
    sessionStorage.setItem("agent-connect.grant", "existing-grant");
    localStorage.setItem(
      "agent-connect.runtime-card",
      JSON.stringify({
        version: 1,
        runtimeId: "sha256:test",
        endpoint: "https://gateway.example",
        connectorPublicKey: {},
        transportProfile: "public-demo",
        authorizationServer: "https://gateway.example",
      }),
    );
  });
  await page.reload();

  await page.getByRole("button", { name: "Disconnect agent" }).click();

  await expect(page.locator("body")).toHaveAttribute(
    "data-demo",
    "disconnected",
  );
  await expect(page.locator("#status")).toHaveText(
    "Disconnected. Run again to authorize this app.",
  );
  expect(
    await page.evaluate(() => sessionStorage.getItem("agent-connect.grant")),
  ).toBeNull();
  expect(revoked).toBe(true);
});

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
