import { expect, test } from "@playwright/test";

test("lends a browser nonce tool to the user's agent", async ({ page }) => {
  const sessionId = process.env["OMNIGENT_SESSION_ID"];
  if (!sessionId) throw new Error("OMNIGENT_SESSION_ID is required");

  const consoleErrors: string[] = [];
  const postedEvents: unknown[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/omnigent/")) {
      postedEvents.push(request.postDataJSON());
    }
  });

  await page.goto(`/?session=${encodeURIComponent(sessionId)}`);
  await page.getByRole("button", { name: "Run with my agent" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-spike", "passed", {
    timeout: 150_000,
  });

  const finalText = await page.locator("output").innerText();
  const eventText = await page.locator("#events").innerText();
  expect(finalText).toContain("browser-");
  expect(eventText.match(/"type":"tool.requested"/g)).toHaveLength(1);
  expect(eventText.match(/"type":"tool.completed"/g)).toHaveLength(1);
  expect(eventText).toContain('"type":"task.completed"');
  expect(postedEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "message",
        tools: [
          expect.objectContaining({
            function: expect.objectContaining({ name: "get_browser_nonce" }),
          }),
        ],
      }),
      expect.objectContaining({
        type: "function_call_output",
        data: expect.objectContaining({ call_id: expect.any(String) }),
      }),
    ]),
  );
  expect(consoleErrors).toEqual([]);

  await page.screenshot({
    path: "../../.omnigent-spike/evidence/browser-nonce.png",
    fullPage: true,
  });
});
