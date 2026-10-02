// Drives the spike page in real Chromium (Playwright) against a running
// gateway. Usage: node drive.mjs <scenario> [label]
//   tools        tool turn; expects a <mark> in the book
//   bad-origin   page served from a non-allowlisted origin
//   bad-token    wrong bearer token
//   ask          human-in-the-loop tool: answer after ASK_WAIT_MS
//   reload-mid   reload while ask_reader is pending, then run a tool turn
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const scenario = process.argv[2] ?? "tools";
const label = process.argv[3] ?? scenario;
const PAGE = process.env.PAGE_ORIGIN ?? "http://127.0.0.1:18941";
const askWait = Number(process.env.ASK_WAIT_MS ?? 3000);
const reportDir = process.env.ACP_REPORT_DIR ?? "../.run/browser";
mkdirSync(reportDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
const consoleLines = [];
page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`));

async function waitStatus(prefixes, timeout = 90_000) {
  await page.waitForFunction(
    (ps) =>
      ps.some((p) =>
        document.getElementById("status").textContent.startsWith(p),
      ),
    prefixes,
    { timeout },
  );
  return page.textContent("#status");
}

const report = { scenario, label };
try {
  if (scenario === "bad-origin") {
    await page.goto(PAGE.replace("127.0.0.1", "localhost"));
    await page.click("#run-tools");
    report.status = await waitStatus(["error", "done"], 20_000);
  } else if (scenario === "bad-token") {
    await page.goto(`${PAGE}${PAGE.includes("?") ? "&" : "?"}token=wrong`);
    await page.click("#run-tools");
    report.status = await waitStatus(["error", "done"], 20_000);
  } else if (scenario === "tools") {
    await page.goto(PAGE);
    await page.click("#run-tools");
    report.status = await waitStatus(["done", "error"]);
    report.marked = await page.$$eval("mark", (ms) =>
      ms.map((m) => m.textContent),
    );
  } else if (scenario === "ask") {
    await page.goto(PAGE);
    await page.click("#run-ask");
    await page.waitForSelector("#ask.open", { timeout: 60_000 });
    report.question = await page.textContent("#ask-question");
    await page.waitForTimeout(askWait);
    await page.click("#ask-answer");
    report.status = await waitStatus(["done", "error"], askWait + 90_000);
  } else if (scenario === "shell") {
    await page.goto(PAGE);
    await page.evaluate(() => window.runShell().catch(() => {}));
    report.status = await waitStatus(["done", "error"]);
  } else if (scenario === "resume") {
    await page.goto(PAGE);
    await page.click("#run-tools");
    report.first = await waitStatus(["done", "error"]);
    report.sessionId = await page.evaluate(() =>
      sessionStorage.getItem("spike-session"),
    );
    await page.reload();
    await page.click("#run-resume");
    report.status = await waitStatus(["done", "error"]);
  } else if (scenario === "load-foreign") {
    await page.goto(PAGE);
    await page.evaluate(() =>
      window.spike
        .resume("SPIKE-TOOLS", "not-a-session-of-this-grant")
        .catch(() => {}),
    );
    report.status = await waitStatus(["done", "error"], 30_000);
  } else if (scenario === "reload-mid") {
    await page.goto(PAGE);
    await page.click("#run-ask");
    await page.waitForSelector("#ask.open", { timeout: 60_000 });
    report.pendingAt = Date.now();
    await page.reload();
    await page.click("#run-tools");
    report.status = await waitStatus(["done", "error"]);
    report.marked = await page.$$eval("mark", (ms) =>
      ms.map((m) => m.textContent),
    );
  }
  report.marked = await page.$$eval("mark", (ms) =>
    ms.map((m) => m.textContent),
  );
  report.answer = await page.textContent("#answer");
} catch (error) {
  report.error = String(error?.message ?? error).split("\n")[0];
}
report.events = await page
  .evaluate(() => window.spike?.events ?? [])
  .catch(() => []);
report.console = consoleLines.slice(0, 20);
await page.screenshot({ path: `${reportDir}/${label}.png`, fullPage: true });
writeFileSync(`${reportDir}/${label}.json`, JSON.stringify(report, null, 2));
await browser.close();
console.log(
  JSON.stringify(
    {
      ...report,
      events: report.events.map((e) => `${e.ms} ${e.kind} ${e.detail}`),
    },
    null,
    1,
  ),
);
