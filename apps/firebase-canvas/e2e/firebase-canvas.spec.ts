import { expect, test, type Page } from "@playwright/test";

const runtimeCard = {
  version: 1,
  runtimeId: "sha256:test",
  endpoint: "https://gateway.example",
  connectorPublicKey: {},
  transportProfile: "public-demo",
  authorizationServer: "https://gateway.example",
};

const plans = {
  "project-board": [
    call("create_project_tasks", {
      tasks: [
        {
          id: "analytics",
          title: "Add launch analytics and alerts",
          priority: "high",
          status: "backlog",
        },
      ],
    }),
    call("update_project_tasks", {
      changes: [
        {
          id: "pricing",
          title: "Confirm launch pricing and upgrade path",
          priority: "high",
        },
      ],
    }),
    call("move_project_tasks", {
      moves: [{ id: "pricing", status: "doing" }],
    }),
  ],
  "document-review": [
    call("add_document_comments", {
      comments: [
        {
          quote: "The first graphical web browser was released in 1989.",
          kind: "fact",
          comment: "This date needs a more careful claim.",
        },
      ],
    }),
    call("replace_document_text", {
      replacements: [
        {
          quote: "The first graphical web browser was released in 1989.",
          replacement:
            "Graphical browsers brought the web to a wider audience in the early 1990s.",
        },
      ],
    }),
    call("format_document_blocks", {
      blocks: [{ blockId: "intro", format: "callout" }],
    }),
  ],
  "product-research": [
    call("add_product_assessment", {
      verdict: "Adult headphones are a poor fit for an eight-year-old.",
      kidFit: "poor",
      concerns: ["No child-specific volume limit is listed."],
    }),
    call("add_price_comparison", {
      listedPrice: 129,
      fairLow: 85,
      fairHigh: 110,
      verdict: "Above the recorded comparison range.",
    }),
    call("add_product_alternatives", {
      alternatives: [
        {
          name: "JBL Junior 320BT",
          price: 50,
          reason: "Child-sized with volume limiting.",
          url: "https://www.jbl.com/kids-headphones/",
        },
      ],
    }),
  ],
} as const;

for (const scenario of Object.keys(plans) as Array<keyof typeof plans>) {
  test(`${scenario} executes its three browser tools`, async ({ page }) => {
    const postedEvents = await mockConnectedRuntime(page, plans[scenario]);
    await openAndConnect(page, "desktop");
    await page.getByRole("tab", { name: scenarioTabName(scenario) }).click();
    await page.getByRole("button", { name: "Run task" }).click();

    await expect(page.locator("body")).toHaveAttribute("data-demo", "passed");
    await expect(page.locator(`#scenario-${scenario}`)).toHaveAttribute(
      "data-changed",
      "true",
    );
    await expect(page.locator("#flow-tool")).toHaveAttribute(
      "data-state",
      "complete",
    );
    await expect(page.locator("#flow-result")).toHaveAttribute(
      "data-state",
      "complete",
    );
    const submittedNames = postedEvents
      .filter(isFunctionOutput)
      .map((event) => event.data.call_id);
    expect(submittedNames).toEqual(["call-1", "call-2", "call-3"]);

    if (scenario === "document-review") {
      await page.getByRole("button", { name: "Run task" }).click();
      await expect(page.locator("body")).toHaveAttribute("data-demo", "passed");
    }
  });
}

test("the mobile page completes the connection before a task can run", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConnectedRuntime(page, plans["project-board"]);
  await openAndConnect(page, "mobile");

  await expect(page.locator("body")).toHaveAttribute("data-layout", "mobile");
  await expect(page.getByRole("button", { name: "Run task" })).toBeEnabled();
  await page.getByRole("button", { name: "Run task" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-demo", "passed");
  await expect(
    page.locator('[data-task-title=""]', {
      hasText: "Add launch analytics and alerts",
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
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
  await page.locator("#runtime-card").fill(JSON.stringify(runtimeCard));
  await page.getByRole("button", { name: "Connect runtime" }).click();

  await expect(page.locator("body")).toHaveAttribute(
    "data-demo",
    "reauthorize",
  );
  await expect(page.locator("#status")).toHaveText(
    "Authorization expired or was revoked. Connect again.",
  );
  await expect(
    page.getByRole("button", { name: "Disconnect and revoke access" }),
  ).toBeHidden();
  expect(
    await page.evaluate(() => sessionStorage.getItem("agent-connect.grant")),
  ).toBeNull();

  await page.getByRole("button", { name: "Connect runtime" }).click();
  await expect.poll(() => challengeRequests).toBe(1);
});

test("disconnect revokes and clears the local grant", async ({ page }) => {
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
  await page.evaluate((card) => {
    sessionStorage.setItem("agent-connect.grant", "existing-grant");
    localStorage.setItem("agent-connect.runtime-card", JSON.stringify(card));
  }, runtimeCard);
  await page.reload();

  await page
    .getByRole("button", { name: "Disconnect and revoke access" })
    .click();

  await expect(page.locator("body")).toHaveAttribute(
    "data-demo",
    "disconnected",
  );
  await expect(page.locator("#status")).toHaveText(
    "Disconnected. Connect again whenever you are ready.",
  );
  expect(
    await page.evaluate(() => sessionStorage.getItem("agent-connect.grant")),
  ).toBeNull();
  expect(revoked).toBe(true);
});

test("an invalid runtime card fails visibly", async ({ page }) => {
  await page.goto("/");
  await page.locator("#runtime-card").fill("not json");
  await page.getByRole("button", { name: "Connect runtime" }).click();

  await expect(page.locator("body")).toHaveAttribute("data-demo", "failed");
  await expect(page.locator("#status")).toHaveText(
    "Paste a valid Agent Connect runtime card",
  );
  await expect(
    page.getByRole("button", { name: "Connect runtime" }),
  ).toBeEnabled();
  await expect(page.locator("#flow-connector")).toHaveAttribute(
    "data-state",
    "error",
  );
});

test("mobile and desktop mount different compositions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-layout", "mobile");
  await expect(
    page.getByRole("heading", { name: "Let Codex work inside your app." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Live request path" }),
  ).toHaveCount(0);

  await page.goto("/?view=desktop");
  await expect(page.locator("body")).toHaveAttribute("data-layout", "desktop");
  await expect(
    page.getByRole("heading", { name: "Live request path" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Two pieces, two owners." }),
  ).toBeVisible();
  const boardTab = page.getByRole("tab", { name: "Project board" });
  await boardTab.focus();
  await boardTab.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Document review" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#scenario-document-review")).toBeVisible();
});

async function openAndConnect(
  page: Page,
  view: "desktop" | "mobile",
): Promise<void> {
  await page.goto(`/?view=${view}`);
  await page.evaluate(() => {
    sessionStorage.setItem("agent-connect.grant", "existing-grant");
  });
  await page.reload();
  await page.locator("#runtime-card").fill(JSON.stringify(runtimeCard));
  await expect(page.getByRole("button", { name: "Run task" })).toBeDisabled();
  await page.getByRole("button", { name: "Connect runtime" }).click();
  await expect(page.locator("#connection-state")).toContainText(
    "Recorded Codex plan",
  );
}

async function mockConnectedRuntime(
  page: Page,
  plan: readonly ReturnType<typeof call>[],
): Promise<unknown[]> {
  const postedEvents: unknown[] = [];
  await page.route("https://gateway.example/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/app-sessions") {
      expect(request.headers()["authorization"]).toBe("Bearer existing-grant");
      const body = request.postDataJSON() as { tools: Array<{ name: string }> };
      expect(body.tools).toHaveLength(9);
      expect(body.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "create_project_tasks",
          "add_document_comments",
          "add_product_assessment",
        ]),
      );
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
          ...plan.map((step, index) =>
            sse({
              type: "response.output_item.done",
              item: {
                type: "function_call",
                status: "action_required",
                call_id: `call-${index + 1}`,
                name: step.name,
                arguments: JSON.stringify(step.arguments),
              },
            }),
          ),
          sse({ type: "response.output_text.delta", delta: "App updated." }),
          sse({ type: "response.completed" }),
        ].join(""),
      });
      return;
    }
    postedEvents.push(request.postDataJSON());
    await route.fulfill({ status: 202, body: "{}" });
  });
  return postedEvents;
}

function call(name: string, arguments_: Record<string, unknown>) {
  return { name, arguments: arguments_ };
}

function scenarioTabName(scenario: keyof typeof plans): string {
  if (scenario === "project-board") return "Project board";
  if (scenario === "document-review") return "Document review";
  return "Product research";
}

function isFunctionOutput(
  event: unknown,
): event is { type: "function_call_output"; data: { call_id: string } } {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { type?: unknown }).type === "function_call_output"
  );
}

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
