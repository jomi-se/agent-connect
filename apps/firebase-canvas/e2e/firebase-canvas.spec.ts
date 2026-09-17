import { expect, test, type Page } from "@playwright/test";

test("presents the independent app with honest demo and connection paths", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Scenarios" })).toBeVisible();
  await expect(
    page.locator(".third-party-brand").getByText("Northstar", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Try the demo" }),
  ).toBeVisible();
  await expect(
    page.getByText("Simulated · no account or model usage"),
  ).toBeVisible();
  await expect(page.getByLabel("Gateway address")).toHaveAttribute(
    "placeholder",
    "https://gateway.example",
  );
  await expect(
    page.getByRole("heading", { name: "Live activity trace" }),
  ).toBeVisible();
  await expect(page.getByText("Runtime card")).toHaveCount(0);
});

test("the deterministic project-board demo mutates the app and trace", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Try the demo" }).click();

  await expect(page.locator('[data-task-id="launch-checklist"]')).toContainText(
    "Prepare launch checklist",
  );
  await expect(page.locator('[data-task-id="pricing"]')).toContainText(
    "Confirm launch pricing",
  );
  await expect(page.locator("#activity-feed")).toContainText(
    "Simulated request",
  );
  await expect(page.locator("#activity-feed")).toContainText("Task complete");
});

test("all three simulation scenarios use the real page-owned tools", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("tab", { name: "Document review" }).click();
  await page.getByRole("button", { name: "Try the demo" }).click();
  await expect(page.locator("#review-comments")).toContainText(
    "This needs evidence",
  );
  await expect(page.locator("#document-block-close")).toContainText(
    "a calmer place",
  );

  await page.getByRole("tab", { name: "Product research" }).click();
  await page.getByRole("button", { name: /Try the demo/ }).click();
  await expect(page.locator("#product-verdict")).toContainText("mixed fit");
  await expect(page.locator("#product-price-range")).toHaveText("€85–€105");
  await expect(page.locator("#product-alternatives")).toContainText(
    "JBL Junior 320BT",
  );
});

test("Pixel 7 gets a deliberate vertical flow with the demo action in view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto("/");

  const demo = page.getByRole("button", { name: "Try the demo" });
  const demoBox = await demo.boundingBox();
  expect(demoBox).not.toBeNull();
  expect(demoBox!.y + demoBox!.height).toBeLessThan(915);
  await expect(page.locator(".scenario-tabs")).toHaveCSS(
    "grid-template-columns",
    /.+ .+ .+/,
  );
  await expect(page.locator(".app-stage")).toBeVisible();
  await expect(page.locator(".entry-panel.connect-entry")).toBeVisible();

  const taskDrawer = page.locator(".task-drawer");
  await expect(taskDrawer).toBeHidden();
  await taskDrawer.evaluate((element) =>
    element.setAttribute("data-open", "true"),
  );
  await expect(taskDrawer).toBeVisible();
  await expect(taskDrawer).toHaveCSS("position", "static");

  const appBox = await page.locator(".app-stage").boundingBox();
  const drawerBox = await taskDrawer.boundingBox();
  const connectBox = await page.locator(".connect-entry").boundingBox();
  expect(appBox).not.toBeNull();
  expect(drawerBox).not.toBeNull();
  expect(connectBox).not.toBeNull();
  expect(drawerBox!.y).toBeGreaterThanOrEqual(appBox!.y + appBox!.height);
  expect(connectBox!.y).toBeGreaterThanOrEqual(
    drawerBox!.y + drawerBox!.height,
  );
});

test("an HTTPS gateway address starts current OAuth discovery and PAR", async ({
  page,
}) => {
  await mockGatewayAuthorization(page);
  await page.goto("/");
  await page.getByLabel("Gateway address").fill("https://gateway.example");
  const authorizationRequest = page.waitForRequest(
    /https:\/\/gateway\.example\/agent-connect\/oauth\/authorize/,
  );
  await page.getByRole("button", { name: /Connect with OAuth/ }).click();

  const url = new URL((await authorizationRequest).url());
  expect(url.searchParams.get("client_id")).toBe("https://canvas.example");
  expect(url.searchParams.get("request_uri")).toBe(
    "urn:ietf:params:oauth:request_uri:canvas",
  );
});

async function mockGatewayAuthorization(page: Page): Promise<void> {
  const origin = "https://gateway.example";
  await page.route(`${origin}/**`, async (route) => {
    const url = route.request().url();
    if (url.endsWith("/.well-known/oauth-authorization-server/agent-connect")) {
      await route.fulfill({
        json: {
          issuer: `${origin}/agent-connect`,
          authorization_endpoint: `${origin}/agent-connect/oauth/authorize`,
          token_endpoint: `${origin}/agent-connect/oauth/token`,
          revocation_endpoint: `${origin}/agent-connect/oauth/revoke`,
          pushed_authorization_request_endpoint: `${origin}/agent-connect/oauth/par`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["responses"],
          authorization_details_types_supported: ["agent_connect"],
          require_pushed_authorization_requests: true,
          authorization_response_iss_parameter_supported: true,
        },
      });
      return;
    }
    if (
      url.endsWith(
        "/.well-known/oauth-protected-resource/agent-connect/v1/responses",
      )
    ) {
      await route.fulfill({
        json: {
          resource: `${origin}/agent-connect/v1/responses`,
          authorization_servers: [`${origin}/agent-connect`],
          scopes_supported: ["responses"],
          bearer_methods_supported: ["header"],
          authorization_details_types_supported: ["agent_connect"],
          agent_connect_model: "openclaw/default",
        },
      });
      return;
    }
    if (url.endsWith("/agent-connect/oauth/par")) {
      await route.fulfill({
        status: 201,
        json: {
          request_uri: "urn:ietf:params:oauth:request_uri:canvas",
          expires_in: 300,
        },
      });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
}
