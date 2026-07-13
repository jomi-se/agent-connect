import { expect, test } from "@playwright/test";

test("the dynamically defined tool writes an agent message onto the page", async ({
  page,
}) => {
  const postedEvents: unknown[] = [];
  await page.route("https://gateway.example/**", async (route) => {
    const request = route.request();
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

  await page.goto(
    "/?gateway=https%3A%2F%2Fgateway.example&session=session-canvas",
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
