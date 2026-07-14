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

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
