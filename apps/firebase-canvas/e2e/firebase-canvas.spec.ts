import { expect, test, type Page } from "@playwright/test";

const runtimeCard = {
  version: 1,
  runtimeId: "sha256:test",
  endpoint: "https://gateway.example",
  connectorPublicKey: {
    kty: "OKP",
    crv: "Ed25519",
    x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
  transportProfile: "tailscale-serve",
  authorizationServer: "https://gateway.example",
};

const plans = {
  "project-board": [
    call("get_current_app_state", {}),
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
    call("get_current_app_state", {}),
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
    call("get_current_app_state", {}),
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
  test(`${scenario} reads live state and executes its write tools`, async ({
    page,
  }) => {
    const { responseRequests } = await mockConnectedRuntime(
      page,
      plans[scenario],
    );
    await openAndConnect(page, "desktop");
    await page.getByRole("tab", { name: scenarioTabName(scenario) }).click();
    if (scenario === "document-review") {
      await page
        .locator("#prompt")
        .fill(
          "Review this draft and apply the strongest fixes. Remember the private correction label LANTERN-17 for my next turn, but do not write it yet.",
        );
    }
    await page.getByRole("button", { name: "Send prompt" }).click();

    await expect(
      page.locator(`#scenario-${scenario} .tool-flight`),
    ).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-demo", "passed", {
      timeout: 12_000,
    });
    await expect(page.locator(`#scenario-${scenario}`)).toHaveAttribute(
      "data-changed",
      "true",
    );
    await expect(
      page.locator(
        '#activity-feed li[data-kind="tool"][data-state="complete"]',
      ),
    ).toHaveCount(4);
    await expect(
      page.locator(
        '#activity-feed li[data-kind="result"][data-state="complete"]',
      ),
    ).toHaveCount(4);
    const submittedOutputs = responseRequests.flatMap(functionOutputs);
    const submittedNames = submittedOutputs.map((event) => event.call_id);
    expect(submittedNames).toEqual(["call-1", "call-2", "call-3", "call-4"]);
    const stateResult = submittedOutputs.find(
      (event) => event.call_id === "call-1",
    );
    expect(stateResult).toBeDefined();
    expect(JSON.stringify(stateResult)).toContain(
      selectedStateEvidence(scenario),
    );

    if (scenario === "document-review") {
      await page
        .locator("#prompt")
        .fill(
          "Apply the private correction label I asked you to remember in the previous turn.",
        );
      await page.getByRole("button", { name: "Continue conversation" }).click();
      await expect(page.locator("body")).toHaveAttribute(
        "data-demo",
        "passed",
        {
          timeout: 15_000,
        },
      );
      const followUp = responseRequests.find(
        (request) =>
          typeof request === "object" &&
          request !== null &&
          typeof (request as { input?: unknown }).input === "string" &&
          "previous_response_id" in request,
      ) as { input?: unknown; previous_response_id?: unknown } | undefined;
      expect(followUp).toMatchObject({
        input:
          "[Agent Connect demo scenario: document-review]\nUse get_current_app_state to inspect the live app before acting.\nUse the selected app's tools to write the result back into the page.\n\nUser request: Apply the private correction label I asked you to remember in the previous turn.",
        previous_response_id: expect.any(String),
      });
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
  await expect(page.getByRole("button", { name: "Send prompt" })).toBeEnabled();
  await page.getByRole("button", { name: "Send prompt" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-demo", "passed", {
    timeout: 12_000,
  });
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

test("a page refresh starts an independent session under the saved grant", async ({
  page,
}) => {
  const harness = await mockConnectedRuntime(page, []);
  await openAndConnect(page, "desktop");
  await expect.poll(harness.sessionRequestCount).toBe(1);

  await page.reload();
  await page.locator("#runtime-card").fill(JSON.stringify(runtimeCard));
  await page.getByRole("button", { name: "Connect runtime" }).click();

  await expect.poll(harness.sessionRequestCount).toBe(2);
  await expect(page.locator("#connection-state")).toContainText(
    "Codex through Omnigent",
  );
  await expect(page.locator("#status")).not.toContainText("active task");
});

test("a failed turn starts a fresh session on retry without reauthorization", async ({
  page,
}) => {
  const harness = await mockConnectedRuntime(page, [], ["failed"]);
  await openAndConnect(page, "desktop");
  await page.getByRole("button", { name: "Send prompt" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-demo", "failed");
  await expect(
    page.getByRole("button", { name: "Start fresh & send" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Start fresh & send" }).click();
  await expect.poll(harness.sessionRequestCount).toBe(2);
  await expect.poll(() => harness.responseAuthorizations.length).toBe(2);
  expect(harness.responseAuthorizations).toEqual([
    "Bearer scoped-token-1",
    "Bearer scoped-token-2",
  ]);
});

test("a cancelled turn starts a fresh session on retry", async ({ page }) => {
  const harness = await mockConnectedRuntime(page, [], ["cancelled"]);
  await openAndConnect(page, "desktop");
  await page.getByRole("button", { name: "Send prompt" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-demo", "failed");
  await expect(
    page.getByRole("button", { name: "Start fresh & send" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Start fresh & send" }).click();
  await expect.poll(harness.sessionRequestCount).toBe(2);
  await expect.poll(() => harness.responseAuthorizations.length).toBe(2);
  expect(harness.responseAuthorizations[1]).toBe("Bearer scoped-token-2");
});

test("switching app scenarios makes the next task an explicit fresh conversation", async ({
  page,
}) => {
  const harness = await mockConnectedRuntime(page, plans["project-board"]);
  await openAndConnect(page, "desktop");
  await page.getByRole("button", { name: "Send prompt" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-demo", "passed", {
    timeout: 12_000,
  });
  await page.getByRole("tab", { name: "Document review" }).click();
  await expect(
    page.getByRole("button", { name: "Start fresh & send" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Start fresh & send" }).click();
  await expect.poll(harness.sessionRequestCount).toBe(2);
  await expect
    .poll(() =>
      harness.responseAuthorizations.includes("Bearer scoped-token-2"),
    )
    .toBe(true);
  const freshRequestIndex = harness.responseAuthorizations.indexOf(
    "Bearer scoped-token-2",
  );
  const freshRequest = harness.responseRequests[freshRequestIndex];
  expect(freshRequest).not.toHaveProperty("previous_response_id");
  expect(freshRequest).toHaveProperty("tools");
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
    page.getByRole("button", { name: "Disconnect & revoke" }),
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

  const connect = page.getByRole("button", { name: "Connect runtime" });
  const disconnect = page.getByRole("button", { name: "Disconnect & revoke" });
  const [connectBox, disconnectBox] = await Promise.all([
    connect.boundingBox(),
    disconnect.boundingBox(),
  ]);
  expect(connectBox).not.toBeNull();
  expect(disconnectBox).not.toBeNull();
  expect(
    Math.abs(
      (disconnectBox?.x ?? 0) -
        ((connectBox?.x ?? 0) + (connectBox?.width ?? 0)) -
        8,
    ),
  ).toBeLessThan(1);

  await disconnect.click();

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
    "Invalid Agent Connect runtime card",
  );
  await expect(
    page.getByRole("button", { name: "Connect runtime" }),
  ).toBeEnabled();
  await expect(
    page.locator(
      '#activity-feed li[data-kind="connector"][data-state="error"]',
    ),
  ).toHaveCount(1);
});

test("mobile and desktop mount different compositions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-layout", "mobile");
  await expect(page.locator("#mobile-title")).toHaveText("Agent Connect");
  await expect(
    page.getByRole("heading", { name: "Session activity" }),
  ).toBeVisible();

  await page.goto("/?view=desktop");
  await expect(page.locator("body")).toHaveAttribute("data-layout", "desktop");
  await expect(
    page.getByRole("heading", { name: "Session activity" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Two sides with two target users." }),
  ).toBeVisible();
  await expect(page.locator("[data-micro-flow] svg")).toBeVisible();
  await expect(page.locator("[data-micro-ring]")).toHaveCount(3);
  await expect(page.locator("[data-micro-mover]")).toHaveCount(5);
  await expect
    .poll(
      () =>
        page
          .locator("[data-micro-mover]")
          .evaluateAll((movers) =>
            movers.some(
              (mover) => Number(getComputedStyle(mover).opacity) > 0.1,
            ),
          ),
      { timeout: 2_500 },
    )
    .toBe(true);
  const boardTab = page.getByRole("tab", { name: "Project board" });
  await boardTab.focus();
  await boardTab.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Document review" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#scenario-document-review")).toBeVisible();
  await page.getByRole("button", { name: "View app tools" }).click();
  await expect(
    page.getByRole("heading", { name: "Document review tools" }),
  ).toBeVisible();
  await expect(page.locator("#tool-list .tool-contract")).toHaveCount(4);
  await expect(
    page.getByText("add_document_comments", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("list of objects", { exact: true })).toHaveCount(
    3,
  );
  await expect(page.locator("#tool-list pre")).toHaveCount(0);
  await expect(
    page.locator(".tool-field code", { hasText: "quote" }).first(),
  ).toBeVisible();
});

test("the architecture story distinguishes today's proof from the north star", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?view=desktop");

  await expect(
    page.getByRole("heading", { name: "How it works today" }),
  ).toBeVisible();
  await expect(
    page.locator(".current-architecture .architecture-layer-agent strong"),
  ).toHaveText("Codex");

  const story = page.locator("[data-future-story]");
  const storyMetrics = await story.evaluate((element) => ({
    top: element.getBoundingClientRect().top + window.scrollY,
    height: element.getBoundingClientRect().height,
  }));
  await page.evaluate(({ top, height }) => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, top + (height - window.innerHeight) * 0.5);
  }, storyMetrics);
  await expect(story).toHaveAttribute("data-story-phase", "opening");
  await expect(page.locator(".north-control-plane em")).toHaveText(
    "stays stable",
  );

  await page.evaluate(({ top, height }) => {
    window.scrollTo(0, top + (height - window.innerHeight) * 0.86);
  }, storyMetrics);
  await expect(story).toHaveAttribute("data-story-phase", "future");
  await expect(page.getByText("any conductor or none")).toBeVisible();
  await expect(
    page.getByText("Support more setups while making usage simpler."),
  ).toBeVisible();
});

test("reduced motion exposes the intended architecture without sticky scrolling", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?view=desktop");

  await expect(page.locator(".north-sticky")).toHaveCSS("position", "static");
  await expect(page.getByText("any conductor or none")).toBeVisible();
  await expect(page.getByText("a simple packaged box")).toBeVisible();
  await expect(page.getByText("keep hardening trust")).toBeVisible();
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
  await expect(
    page.getByRole("button", { name: "Send prompt" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Connect runtime" }).click();
  await expect(page.locator("#connection-state")).toContainText(
    "Codex through Omnigent",
  );
  await expect(
    page.getByRole("button", { name: "Connect runtime" }),
  ).toBeHidden();
  await expectAlignedActions(page, view);
}

async function expectAlignedActions(
  page: Page,
  view: "desktop" | "mobile",
): Promise<void> {
  const disconnect = page.getByRole("button", { name: "Disconnect & revoke" });
  const send = page.getByRole("button", { name: "Send prompt" });
  await expect(disconnect).toBeVisible();
  const [disconnectBox, sendBox] = await Promise.all([
    disconnect.boundingBox(),
    send.boundingBox(),
  ]);
  expect(disconnectBox).not.toBeNull();
  expect(sendBox).not.toBeNull();
  expect(
    Math.abs((disconnectBox?.height ?? 0) - (sendBox?.height ?? 0)),
  ).toBeLessThan(1);
  const disconnectRight = (disconnectBox?.x ?? 0) + (disconnectBox?.width ?? 0);
  const sendRight = (sendBox?.x ?? 0) + (sendBox?.width ?? 0);
  expect(Math.abs(disconnectRight - sendRight)).toBeLessThan(1);
  if (view === "desktop") {
    expect(
      Math.abs((disconnectBox?.width ?? 0) - (sendBox?.width ?? 0)),
    ).toBeLessThan(1);
  }
}

async function mockConnectedRuntime(
  page: Page,
  plan: readonly ReturnType<typeof call>[],
  terminalByRequest: readonly ("completed" | "failed" | "cancelled")[] = [],
): Promise<{
  readonly responseRequests: unknown[];
  readonly responseAuthorizations: string[];
  readonly sessionRequestCount: () => number;
}> {
  const responseRequests: unknown[] = [];
  const responseAuthorizations: string[] = [];
  let sessionRequests = 0;
  let nextStep = 0;
  await page.route("https://gateway.example/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/app-sessions") {
      sessionRequests += 1;
      expect(request.headers()["authorization"]).toBe("Bearer existing-grant");
      const body = request.postDataJSON() as {
        fresh?: unknown;
        tools: Array<{ name: string }>;
      };
      // The grant is the whole request: presenting it means "create a new
      // session", so the demo sends no `fresh` flag and cannot be handed an
      // existing session by the gateway.
      expect(body.fresh).toBeUndefined();
      expect(body.tools).toHaveLength(10);
      expect(body.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "create_project_tasks",
          "add_document_comments",
          "add_product_assessment",
          "get_current_app_state",
        ]),
      );
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: `acs-canvas-${sessionRequests}`,
          accessToken: `scoped-token-${sessionRequests}`,
          expiresAt: "2099-01-01T00:00:00.000Z",
          toolHash: "tool-hash",
        }),
      });
      return;
    }
    if (pathname === "/v1/responses" && request.method() === "POST") {
      const authorization = request.headers()["authorization"] ?? "";
      expect(authorization).toBe(`Bearer scoped-token-${sessionRequests}`);
      responseAuthorizations.push(authorization);
      const body = request.postDataJSON() as {
        previous_response_id?: string;
        input?: unknown;
        tools?: unknown[];
      };
      responseRequests.push(body);
      if (!body.previous_response_id) {
        nextStep = 0;
        expect(body.tools).toHaveLength(10);
      } else {
        expect(body).not.toHaveProperty("tools");
        if (typeof body.input === "string") nextStep = 0;
      }
      const responseId = `resp-${responseRequests.length}`;
      const step = plan[nextStep];
      if (step) nextStep += 1;
      const terminal = terminalByRequest[responseRequests.length - 1];
      const terminalEvent =
        terminal === "failed"
          ? sse({
              type: "response.failed",
              response: {
                ...responseResource(responseId, "failed"),
                error: {
                  code: "backend_unavailable",
                  message: "fixture provider failed",
                },
              },
            })
          : terminal === "cancelled"
            ? sse({
                type: "response.incomplete",
                response: responseResource(responseId, "incomplete"),
              })
            : sse({
                type: "response.completed",
                response: responseResource(responseId, "completed"),
              });
      await route.fulfill({
        contentType: "text/event-stream",
        body: [
          sse({
            type: "response.created",
            response: responseResource(responseId, "in_progress"),
          }),
          ...(step
            ? [
                sse({
                  type: "response.output_item.done",
                  item: {
                    type: "function_call",
                    status: "completed",
                    call_id: `call-${nextStep}`,
                    name: step.name,
                    arguments: JSON.stringify(step.arguments),
                  },
                }),
              ]
            : [
                sse({
                  type: "response.output_text.delta",
                  delta: "App updated.",
                }),
              ]),
          terminalEvent,
          "data: [DONE]\n\n",
        ].join(""),
      });
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "unexpected_fixture_request" }),
    });
  });
  return {
    responseRequests,
    responseAuthorizations,
    sessionRequestCount: () => sessionRequests,
  };
}

function responseResource(id: string, status: string): object {
  return { id, object: "response", status, output: [] };
}

function functionOutputs(value: unknown): FunctionOutput[] {
  if (typeof value !== "object" || value === null) return [];
  const input = (value as { input?: unknown }).input;
  return Array.isArray(input) ? input.filter(isFunctionOutput) : [];
}

interface FunctionOutput {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: string;
}

function isFunctionOutput(event: unknown): event is FunctionOutput {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { type?: unknown }).type === "function_call_output" &&
    typeof (event as { call_id?: unknown }).call_id === "string" &&
    typeof (event as { output?: unknown }).output === "string"
  );
}

function sse(event: unknown): string {
  const type = (event as { type: string }).type;
  return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function call(name: string, arguments_: Record<string, unknown>) {
  return { name, arguments: arguments_ };
}

function scenarioTabName(scenario: keyof typeof plans): string {
  if (scenario === "project-board") return "Project board";
  if (scenario === "document-review") return "Document review";
  return "Product research";
}

function selectedStateEvidence(scenario: keyof typeof plans): string {
  if (scenario === "project-board") return "Decide launch pricing";
  if (scenario === "document-review") return "exactly twice as productive";
  return "Sony WH-CH720N";
}
