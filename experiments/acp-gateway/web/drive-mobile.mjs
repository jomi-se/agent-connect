// Mobile-lifecycle scenarios for the resumable gateway, in real Chromium.
// The page talks to the gateway through relay.mjs, which can cut, blackhole
// or refuse connections. Backgrounding is modeled by freezing the page through
// pausing its JavaScript through the Chrome DevTools Protocol debugger: timers,
// socket events and handlers queue until resume, as in a frozen background
// tab. (Page.setWebLifecycleState "frozen" does not stop timers on a visible
// headless page.) Visibility is emulated so the page sees hidden, then visible.
//
// Usage: PAGE_ORIGIN=... RELAY_CONTROL=http://127.0.0.1:18947 node drive-mobile.mjs <scenario>
//   slow-cut         M1: freeze + cut + offline during a streaming turn
//   ask-cut          M2a: tool call pending before the cut
//   lateask-cut      M2b: tool call issued while the page is away
//   answer-halfopen  M2c+M3: answer written into a half-open socket
//   halfopen-stream  M3: half-open socket during a streaming turn
//   expire           M4: away longer than the gateway grace; recover by load
//   overflow         M4: retained output exceeds the gateway bound
//   takeover         M5: reattach checks and takeover
//   discard          M6: tab discarded mid-turn, then session/load
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const scenario = process.argv[2] ?? "slow-cut";
const label = process.argv[3] ?? scenario;
const PAGE = process.env.PAGE_ORIGIN ?? "http://127.0.0.1:18941";
const RELAY = process.env.RELAY_CONTROL ?? "http://127.0.0.1:18947";
const AWAY_MS = Number(process.env.AWAY_MS ?? 10_000);
const EXPECTED_SLOW =
  Array.from(
    { length: 30 },
    (_, i) => `w${String(i + 1).padStart(2, "0")} `,
  ).join("") + "DONE-SLOW";
const reportDir = process.env.ACP_REPORT_DIR ?? "../.run/browser";
mkdirSync(reportDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
});
await context.addInitScript(() => {
  window.__visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => window.__visibility,
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => window.__visibility === "hidden",
  });
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Debugger.enable");
const consoleLines = [];
page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`));

const relay = async (action) =>
  (await fetch(`${RELAY}/${action}`, { method: "POST" })).json();
const setVisibility = (state, p = page) =>
  p.evaluate((s) => {
    window.__visibility = s;
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
const freeze = async () => {
  await setVisibility("hidden");
  await cdp.send("Debugger.pause");
};
const unfreeze = () => cdp.send("Debugger.resume");
const foreground = (p = page) => setVisibility("visible", p);
const cleanAnswer = () =>
  page.evaluate(() =>
    window.spike.answer().replace(/^Warning: Model metadata[^\n]*\n+/, ""),
  );
const status = (p = page) => p.textContent("#status");
async function waitStatus(prefixes, timeout = 90_000, p = page) {
  await p.waitForFunction(
    (ps) =>
      ps.some((x) =>
        document.getElementById("status").textContent.startsWith(x),
      ),
    prefixes,
    { timeout },
  );
  return status(p);
}
const waitAnswer = (text, timeout = 30_000) =>
  page.waitForFunction((t) => window.spike.answer().includes(t), text, {
    timeout,
  });

// The phone goes away: the tab is frozen, the OS drops the socket, and the
// network stays down for a while.
async function goAway(ms = AWAY_MS) {
  await freeze();
  await relay("cut");
  await relay("refuse");
  await page.waitForTimeout(ms);
  await relay("heal");
  await unfreeze();
  await foreground();
}

const report = { scenario, label };
const t0 = Date.now();
try {
  await page.goto(PAGE);
  if (scenario === "slow-cut" || scenario === "overflow") {
    page
      .evaluate(() => window.spike.run("SPIKE-SLOW stream please"))
      .catch(() => {});
    await waitAnswer("w05");
    await goAway();
    report.status = await waitStatus(
      scenario === "overflow"
        ? ["done", "recovered"]
        : ["done", "error", "recovered"],
    );
    report.answerExact = (await cleanAnswer()) === EXPECTED_SLOW;
    report.answer = (await cleanAnswer()).slice(-40);
  } else if (scenario === "ask-cut") {
    await page.click("#run-ask");
    await page.waitForSelector("#ask.open", { timeout: 60_000 });
    await goAway();
    await page.click("#ask-answer");
    report.status = await waitStatus(["done", "error", "recovered"]);
  } else if (scenario === "lateask-cut") {
    page
      .evaluate(() => window.spike.run("SPIKE-LATEASK please"))
      .catch(() => {});
    await page.waitForTimeout(1500);
    report.askOpenBeforeAway = await page.$eval("#ask", (e) =>
      e.classList.contains("open"),
    );
    await goAway(15_000);
    await page.waitForSelector("#ask.open", { timeout: 30_000 });
    await page.click("#ask-answer");
    report.status = await waitStatus(["done", "error", "recovered"]);
  } else if (scenario === "answer-halfopen") {
    await page.click("#run-ask");
    await page.waitForSelector("#ask.open", { timeout: 60_000 });
    await relay("blackhole");
    await page.click("#ask-answer"); // written into a socket that looks open
    await page.waitForTimeout(3000);
    report.statusWhileHalfOpen = await status();
    await foreground();
    report.status = await waitStatus(["done", "error", "recovered"]);
  } else if (scenario === "halfopen-stream") {
    page
      .evaluate(() => window.spike.run("SPIKE-SLOW stream please"))
      .catch(() => {});
    await waitAnswer("w05");
    await relay("blackhole");
    await page.waitForTimeout(3000);
    await foreground();
    report.status = await waitStatus(["done", "error", "recovered"]);
    report.answerExact = (await cleanAnswer()) === EXPECTED_SLOW;
  } else if (scenario === "expire") {
    await page.click("#run-ask");
    await page.waitForSelector("#ask.open", { timeout: 60_000 });
    await goAway();
    report.status = await waitStatus(["recovered", "done"], 60_000);
    await page.waitForTimeout(500);
    report.status = await status();
  } else if (scenario === "takeover") {
    await page.click("#run-ask");
    await page.waitForSelector("#ask.open", { timeout: 60_000 });
    const token = await page.evaluate(
      () => window.spike.transport().resumeToken,
    );
    const gateway = new URL(PAGE).searchParams.get("gateway");
    const other = await context.newPage();
    await other.goto(PAGE);
    const attempt = (bearer, resume) =>
      other.evaluate(
        ([url, bearer, resume]) =>
          new Promise((done) => {
            const ws = new WebSocket(url, [
              "agent-connect.resume.v1",
              `bearer.${bearer}`,
            ]);
            const got = [];
            ws.onopen = () =>
              ws.send(JSON.stringify({ t: "attach", resume, ack: 0 }));
            ws.onmessage = (e) => got.push(JSON.parse(e.data).t);
            ws.onclose = (e) => done({ code: e.code, got: got.slice(0, 3) });
            setTimeout(() => {
              done({ open: ws.readyState === 1, got: got.slice(0, 3) });
              ws.close();
            }, 3000);
          }),
        [gateway, bearer, resume],
      );
    report.wrongBearer = await attempt("wrong", token);
    report.wrongResume = await attempt("spike-dev-token", "0".repeat(64));
    report.rightToken = await attempt("spike-dev-token", token);
    await page.waitForTimeout(500);
    report.firstPage = await page.evaluate(() => window.spike.transport());
    report.status = await status();
    const foreign = await browser.newPage();
    await foreign.goto(PAGE.replace("127.0.0.1", "localhost"));
    report.wrongOrigin = await foreign.evaluate(
      ([url, resume]) =>
        new Promise((done) => {
          const ws = new WebSocket(url.replace("127.0.0.1", "localhost"), [
            "agent-connect.resume.v1",
            "bearer.spike-dev-token",
          ]);
          ws.onopen = () =>
            ws.send(JSON.stringify({ t: "attach", resume, ack: 0 }));
          ws.onclose = (e) => done({ code: e.code });
          ws.onerror = () => {};
        }),
      [gateway, token],
    );
  } else if (scenario === "discard") {
    await page.click("#run-ask");
    await page.waitForSelector("#ask.open", { timeout: 60_000 });
    report.session = await page.evaluate(() =>
      sessionStorage.getItem("spike-session"),
    );
    await page.reload(); // the OS discarded the tab; the page starts fresh
    await page.click("#run-resume");
    report.status = await waitStatus(["done", "error"], 90_000);
    report.marked = await page.$$eval("mark", (ms) =>
      ms.map((m) => m.textContent),
    );
  }
  report.elapsedMs = Date.now() - t0;
  report.toolCounts = await page.evaluate(() => window.spike.toolCounts);
  report.transport = await page.evaluate(() => window.spike.transport());
  if (report.transport) delete report.transport.resumeToken;
  report.relay = await relay("stats");
} catch (error) {
  report.error = String(error?.message ?? error).split("\n")[0];
  report.status = await status().catch(() => "?");
} finally {
  report.events = await page
    .evaluate(() => window.spike.events)
    .catch(() => []);
  report.console = consoleLines.slice(-20);
  writeFileSync(
    `${reportDir}/mobile-${label}.json`,
    JSON.stringify(report, null, 2),
  );
  const { events, console: _c, ...brief } = report;
  console.log(JSON.stringify(brief));
  await browser.close();
}
