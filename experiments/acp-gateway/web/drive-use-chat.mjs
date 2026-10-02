// Real useChat hook + product SDK + pinned adapters; deterministic inference only.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const origin = process.env.PAGE_ORIGIN;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`${origin}${origin.includes("?") ? "&" : "?"}chat=1`);
  await page.waitForSelector("#chat-input");
  await page.fill("#chat-input", "SPIKE-TOOLS read and highlight");
  await page.click("#chat-send");
  await page.waitForFunction(
    () =>
      document.querySelector("#chat-status")?.textContent === "ready" &&
      document.querySelector("#chat-messages")?.textContent.includes("DONE"),
    {},
    { timeout: 90000 },
  );
  const first = await page.evaluate(() => ({
    marked: [...document.querySelectorAll("mark")].map((m) => m.textContent),
    tools: window.spike.toolCounts,
    sessionId: sessionStorage.getItem("spike-session"),
  }));
  assert.ok(first.marked.length);
  assert.equal(first.tools.read_passage, 1);
  assert.equal(first.tools.highlight, 1);
  assert.ok(await page.locator("[data-tool]").count());
  await page.fill("#chat-input", "SPIKE-PROGRESS thoughts and plan");
  await page.click("#chat-send");
  await page.waitForFunction(
    () =>
      document.querySelector("#chat-status")?.textContent === "ready" &&
      document
        .querySelector("#chat-messages")
        ?.textContent.includes("PROGRESS-DONE"),
    {},
    { timeout: 90000 },
  );
  assert.ok(
    await page.locator("#chat-messages details").count(),
    "Reasoning UI missing",
  );
  const plans = await page.locator("[data-plan]").count();
  const planUnavailable = (
    await page.locator("#chat-messages").innerText()
  ).includes("native plan tool unavailable");
  if (!planUnavailable) assert.ok(plans, "Plan UI missing");
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("spike-session")),
    first.sessionId,
  );
  await page.fill("#chat-input", "SPIKE-ASK please");
  await page.click("#chat-send");
  await page.waitForSelector("#ask.open", { timeout: 60000 });
  await page.click("#chat-stop");
  await page.waitForFunction(
    () => document.querySelector("#chat-status")?.textContent === "ready",
    {},
    { timeout: 60000 },
  );
  assert.equal(
    await page.evaluate(() => window.spike.toolCounts.ask_reader),
    1,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: "done:useChat",
      plans,
      planUnavailable,
      sessionId: first.sessionId,
      marked: first.marked,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      error: String(error),
      ui: await page
        .locator("#use-chat")
        .innerText()
        .catch(() => ""),
      events: await page.evaluate(() => window.spike?.events.slice(-12)),
      errors,
    }),
  );
  throw error;
} finally {
  await browser.close();
}
