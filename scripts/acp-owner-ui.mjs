// Credential-free browser qualification of the gateway-owned authorization UI.
// Screenshots and synthetic owner/factor state stay in a private temporary root.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { runCleanupTasks } from "./test-fixture-cleanup.mjs";

const repo = resolve(import.meta.dirname, "..");
const root = await mkdtemp(join(tmpdir(), "acp-owner-ui-"));
const screenshots = join(root, "screenshots");
await Promise.all(
  ["home", "state", "screenshots"].map((name) => mkdir(join(root, name))),
);
// Controlled ACP endpoint for gateway-owned console state only. It proves no
// native adapter behavior and invokes no provider, shell tool, login or Docker.
const adapterDirectory = join(root, "adapters/node_modules/.bin");
await mkdir(adapterDirectory, { recursive: true });
const uiAdapter = join(adapterDirectory, "codex-acp");
await writeFile(
  uiAdapter,
  `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  const result = message.method === "initialize"
    ? { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "console-contract-fixture", version: "1" } }
    : message.method === "session/new" ? { sessionId: randomUUID() }
    : message.method === "session/prompt" ? { stopReason: "end_turn" } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`,
);
await chmod(uiAdapter, 0o700);
const fixtureEnv = {
  PATH: process.env.PATH,
  HOME: join(root, "home"),
  XDG_STATE_HOME: join(root, "state"),
  RUST_LOG: "info",
};
const password = "isolated-owner-browser-test";
const passwordFile = join(root, "passphrase");
await writeFile(passwordFile, password, { mode: 0o600 });
const listener = net.createServer();
await new Promise((ok) => listener.listen(0, "127.0.0.1", ok));
const port = listener.address().port;
await new Promise((ok) => listener.close(ok));
const origin = `http://127.0.0.1:${port}`;
const application = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(
    "<!doctype html><html lang=en><title>Test app</title><main><h1>Returned to app</h1></main></html>",
  );
});
await new Promise((ok) => application.listen(0, "127.0.0.1", ok));
const appOrigin = `http://127.0.0.1:${application.address().port}`;
const binary = join(repo, "target/debug/agent-connect-gateway");
const build = spawnSync(
  "cargo",
  ["build", "--locked", "--bin", "agent-connect-gateway"],
  { cwd: repo, encoding: "utf8" },
);
assert.equal(build.status, 0, build.stderr);
const setup = spawnSync(
  binary,
  [
    "init",
    "--directory",
    join(root, "runtime"),
    "--harness",
    "codex",
    "--public-url",
    origin,
    "--owner-passphrase-file",
    passwordFile,
  ],
  { env: fixtureEnv, encoding: "utf8" },
);
assert.equal(setup.status, 0, setup.stderr);
const configPath = join(root, "runtime/config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
// This first runtime uses a controlled ACP endpoint solely for owner session controls.
Object.assign(config, {
  boxed: false,
  mock_root: root,
  harness_home: undefined,
  listen: `127.0.0.1:${port}`,
});
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
const gateway = spawn(binary, ["serve", "--config", configPath], {
  env: fixtureEnv,
  stdio: ["ignore", "ignore", "pipe"],
});
let diagnostics = "";
gateway.stderr.on("data", (chunk) => {
  diagnostics = (diagnostics + chunk).slice(-4000);
});
const gatewayExit = new Promise((ok) => gateway.once("exit", ok));
const states = [];
const views = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "phone", width: 390, height: 844 },
  { name: "reflow", width: 320, height: 800 },
];
let browser;
let problemGateway;
let problemGatewayExit;
const problemEgress = `acp-owner-ui-egress-${root.split("-").at(-1).toLowerCase()}`;
let problemEgressAllocated = false;
function run(binary, args) {
  const result = spawnSync(binary, args, {
    env: fixtureEnv,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(result.status, 0, (result.stderr + result.stdout).slice(-4000));
  return result.stdout;
}
console.log(`Owner UI review artifacts: ${join(root, "report.json")}`);
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (diagnostics.includes("listening on")) break;
    assert.equal(gateway.exitCode, null, diagnostics);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.match(diagnostics, /listening on/);
  browser = await chromium.launch({ env: fixtureEnv });
  const context = await browser.newContext();
  // Both owner pages and the synthetic app callback are served by real local HTTP.
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  async function capture(name, { compact = false, target = page } = {}) {
    for (const view of views) {
      await target.setViewportSize({ width: view.width, height: view.height });
      const geometry = await target.evaluate(() => ({
        width: innerWidth,
        contentWidth: document.documentElement.scrollWidth,
        surfaceWidth: document.querySelector(".surface").getBoundingClientRect()
          .width,
        headings: document.querySelectorAll("h1").length,
        main: document.querySelectorAll("main").length,
      }));
      assert.equal(geometry.headings, 1, name);
      assert.equal(geometry.main, 1, name);
      assert.ok(
        geometry.contentWidth <= geometry.width + 1,
        `${name}/${view.name} overflows: ${JSON.stringify(geometry)}`,
      );
      if (compact && view.name === "desktop")
        assert.ok(
          geometry.surfaceWidth <= 600,
          `${name} auth panel is too wide`,
        );
      if (view.name !== "desktop") {
        for (const control of await target
          .locator("button, select, input:not([type=hidden]), summary")
          .all()) {
          if (!(await control.isVisible())) continue;
          const box = await control.boundingBox();
          assert.ok(
            box.height >= 44,
            `${name} touch target is shorter than 44px`,
          );
        }
      }
      await target.screenshot({
        path: join(screenshots, `${name}-${view.name}.png`),
        fullPage: true,
      });
    }
    states.push(name);
  }
  const owner = `${origin}/agent-connect/owner`;
  await page.goto(owner);
  await capture("sign-in", { compact: true });
  await page.keyboard.press("Tab");
  await page.getByLabel("Owner passphrase").evaluate((input) => {
    assertBrowser(
      input === document.activeElement,
      "Passphrase must be first in keyboard order",
    );
    const style = getComputedStyle(input);
    assertBrowser(
      style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 3,
      "Visible focus outline required",
    );
    function assertBrowser(condition, message) {
      if (!condition) throw Error(message);
    }
  });
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByRole("button", { name: "Sign in" })
      .evaluate((button) => button === document.activeElement),
    true,
  );
  await page
    .getByLabel("Owner passphrase")
    .fill("deliberately-wrong-test-passphrase");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page
    .getByRole("heading", { name: "Sign-in did not complete" })
    .waitFor();
  await capture("sign-in-error", { compact: true });
  await page.goto(owner);
  await page.getByLabel("Owner passphrase").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page
    .getByRole("heading", { name: "Application access", exact: true, level: 1 })
    .waitFor();
  await page.getByRole("group", { name: "Access summary" }).waitFor();
  await page
    .getByRole("heading", { name: "Live sessions", exact: true })
    .waitFor();
  await page.getByText("No live sessions", { exact: true }).waitFor();
  assert.ok(
    await page
      .getByRole("button", { name: "Revoke all active grants", exact: true })
      .isDisabled(),
  );
  await page
    .getByRole("heading", { name: "Restricted profiles", exact: true })
    .waitFor();
  await page
    .getByText(
      /Deny-all and app-tools-only profiles are unavailable for boxed Codex/,
    )
    .waitFor();
  await page
    .getByRole("heading", { name: "Gateway entry points", exact: true })
    .waitFor();
  await capture("empty-console");
  await capture("profiles-supported-and-unavailable");

  let pendingAuthorization;
  async function push({ stress = false } = {}) {
    const client = stress
      ? `https://${["library".repeat(8), "books".repeat(10), "reading".repeat(8), "app", "example"].join(".")}`
      : appOrigin;
    const verifier = "synthetic-visual-pkce-verifier-".repeat(3);
    const tools = [
      {
        name: stress ? `read_${"chapter".repeat(8)}` : "read_passage",
        description: "Read a chapter from the book currently open in the app.",
        inputSchema: {
          type: "object",
          properties: {
            chapter: {
              type: "integer",
              description: "An intentionally long schema description ".repeat(
                8,
              ),
            },
          },
          required: ["chapter"],
          additionalProperties: false,
        },
      },
      {
        name: "highlight_text",
        description:
          "Highlight the exact passage requested by the reader. This changes the application.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    ];
    pendingAuthorization = {
      client,
      verifier,
      redirectUri: `${client}/callback`,
    };
    const params = new URLSearchParams({
      client_id: client,
      client_name: stress ? "Library".repeat(28) : "The evening library",
      redirect_uri: `${client}/callback`,
      resource: `${origin}/acp`,
      response_type: "code",
      scope: "acp",
      state: "synthetic-visual-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      authorization_details: JSON.stringify([{ type: "agent_connect", tools }]),
    });
    const reply = await fetch(`${origin}/agent-connect/oauth/par`, {
      method: "POST",
      headers: { Origin: client },
      body: params,
    });
    assert.equal(reply.status, 201);
    const { request_uri } = await reply.json();
    return `${origin}/agent-connect/oauth/authorize?${new URLSearchParams({ client_id: client, request_uri })}`;
  }
  const consent = await push();
  await page.goto(owner);
  await page
    .getByRole("button", { name: "Create enrollment secret" })
    .waitFor();
  await capture("pending-console");
  await page.goto(consent);
  const profile = page.getByLabel("Restricted profile", { exact: true });
  assert.deepEqual(
    await profile
      .locator("option")
      .evaluateAll((options) => options.map((option) => option.value)),
    ["sandboxed", "read-only"],
  );
  await profile.focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await profile.inputValue(), "read-only");
  await page.keyboard.press("ArrowUp");
  assert.equal(await profile.inputValue(), "sandboxed");
  await capture("consent");
  const disclosure = page
    .getByText("View exact input schema", { exact: true })
    .first();
  await disclosure.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("details").first().getAttribute("open"), "");
  await capture("expanded-schema");
  const schema = page.getByRole("region", {
    name: "Input schema for read_passage",
  });
  await schema.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  assert.ok(
    await schema.evaluate((element) => element.scrollLeft > 0),
    "Schema must scroll with the keyboard",
  );
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.waitForURL(`${appOrigin}/**`);
  const authorizationCode = new URL(page.url()).searchParams.get("code");
  assert.ok(authorizationCode);
  const exchanged = await fetch(`${origin}/agent-connect/oauth/token`, {
    method: "POST",
    headers: { Origin: appOrigin },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      client_id: pendingAuthorization.client,
      redirect_uri: pendingAuthorization.redirectUri,
      code_verifier: pendingAuthorization.verifier,
      resource: `${origin}/acp`,
    }),
  });
  assert.equal(exchanged.status, 200);
  const access = await exchanged.json();
  const runtimePage = await context.newPage();
  await runtimePage.goto(appOrigin);
  await runtimePage.evaluate(
    async ({ origin, token }) => {
      const socket = new WebSocket(origin.replace(/^http/, "ws") + "/acp", [
        "acp.v1",
        `bearer.${token}`,
      ]);
      window.consoleFixtureSocket = socket;
      socket.onclose = ({ code }) => {
        window.consoleFixtureCloseCode = code;
      };
      let serial = 0;
      const waiting = new Map();
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (!message.method) {
          waiting.get(message.id)?.(message);
          waiting.delete(message.id);
        }
      };
      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () =>
          reject(new Error("console fixture transport failed"));
      });
      async function request(method, params) {
        return await new Promise((resolve, reject) => {
          const id = ++serial;
          const timer = setTimeout(
            () => reject(new Error(`console fixture timed out: ${method}`)),
            10000,
          );
          waiting.set(id, (message) => {
            clearTimeout(timer);
            message.error
              ? reject(new Error(message.error.message))
              : resolve(message.result);
          });
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      }
      await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      await request("session/new", {
        cwd: "/unapproved-workspace",
        mcpServers: [],
      });
    },
    { origin, token: access.access_token },
  );
  await page.goto(owner);
  await page.getByText("Active", { exact: true }).last().waitFor();
  await capture("active-grant");
  const endSession = page.getByRole("button", {
    name: "End session",
    exact: true,
  });
  await endSession.waitFor();
  await capture("live-session");
  await endSession.focus();
  assert.equal(
    await endSession.evaluate((button) => button === document.activeElement),
    true,
  );
  await page.keyboard.press("Enter");
  await page.getByText("No live sessions", { exact: true }).waitFor();
  await runtimePage.waitForFunction(
    () => window.consoleFixtureCloseCode === 4415,
  );
  assert.ok(
    await page
      .getByRole("button", { name: "Revoke access", exact: true })
      .isVisible(),
    "ending a host retains its application grant",
  );
  await capture("ended-session-active-grant");
  await runtimePage.close();
  await page.getByRole("button", { name: "Revoke access" }).click();
  await page.getByText("Revoked", { exact: true }).waitFor();
  await capture("revoked-grant");
  await page.goto(await push());
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.waitForURL(`${appOrigin}/**`);
  await page.goto(owner);
  const revokeAll = page.getByRole("button", {
    name: "Revoke all active grants",
    exact: true,
  });
  await revokeAll.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () =>
      document.querySelector(
        'form[action="/agent-connect/owner/grants/revoke-all"] button',
      )?.disabled === true,
  );
  assert.ok(
    await page
      .getByRole("button", { name: "Revoke all active grants", exact: true })
      .isDisabled(),
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Revoke access", exact: true })
      .count(),
    0,
  );
  await capture("all-grants-revoked");
  const forget = page.getByRole("button", {
    name: "Forget this browser",
    exact: true,
  });
  await forget.focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("Owner passphrase").waitFor();
  await capture("forgotten-browser", { compact: true });
  await page.getByLabel("Owner passphrase").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Application access", exact: true, level: 1 })
    .waitFor();

  await page.goto(await push({ stress: true }));
  await capture("long-app-origin-and-tool-names");
  await page.goto(owner);
  await capture("long-pending-origin");
  await page.getByLabel("Confirm owner passphrase").fill(password);
  await page.getByRole("button", { name: "Create enrollment secret" }).click();
  await page.getByRole("heading", { name: "Enroll authenticator" }).waitFor();
  await capture("factor-enrollment", { compact: true });
  const uri = await page
    .getByRole("link", { name: "Open authenticator" })
    .getAttribute("href");
  const secret = new URL(uri).searchParams.get("secret");
  const bits = [...secret]
    .map((letter) =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        .indexOf(letter)
        .toString(2)
        .padStart(5, "0"),
    )
    .join("");
  const bytes = Buffer.from(
    bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)),
  );
  const step = Buffer.alloc(8);
  step.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", bytes).update(step).digest();
  const offset = digest.at(-1) & 15;
  const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1e6)
    .toString()
    .padStart(6, "0");
  await page.getByLabel("Authenticator code").fill(code);
  await page.getByRole("button", { name: "Confirm enrollment" }).click();
  await page.getByText("Authenticator enrolled", { exact: true }).waitFor();
  await capture("factor-enrolled");
  await page.goto(await push());
  await page.getByLabel("Fresh authenticator code").waitFor();
  await capture("factor-consent");
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await page.waitForURL(`${appOrigin}/**`);
  await page.goto(owner);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Authenticator code").waitFor();
  await capture("factor-sign-in", { compact: true });
  // A real, isolated boxed runtime with no agent sessions exercises health UI.
  // Stop only this test's owned egress; no provider credentials or login are used.
  const probeListener = net.createServer();
  await new Promise((ok) => probeListener.listen(0, "127.0.0.1", ok));
  const probePort = probeListener.address().port;
  await new Promise((ok) => probeListener.close(ok));
  const probeOrigin = `http://127.0.0.1:${probePort}`;
  const probeRuntime = join(root, "problem-runtime");
  const version = JSON.parse(
    await readFile(join(repo, "packages/gateway-npm/package.json"), "utf8"),
  ).version;
  const sessionImage =
    process.env.ACP_SESSION_IMAGE ?? `agent-connect-session:${version}`;
  run(binary, [
    "init",
    "--directory",
    probeRuntime,
    "--harness",
    "codex",
    "--public-url",
    probeOrigin,
    "--harness-home",
    join(root, "problem-harness-home"),
    "--owner-passphrase-file",
    passwordFile,
  ]);
  const probeConfigPath = join(probeRuntime, "config.json");
  const probeConfig = JSON.parse(await readFile(probeConfigPath, "utf8"));
  probeConfig.listen = `127.0.0.1:${probePort}`;
  probeConfig.session_image = sessionImage;
  probeConfig.egress_container = problemEgress;
  await writeFile(probeConfigPath, JSON.stringify(probeConfig), {
    mode: 0o600,
  });
  problemEgressAllocated = true;
  run(binary, [
    "egress",
    "start",
    "--name",
    problemEgress,
    "--session-image",
    sessionImage,
  ]);
  problemGateway = spawn(binary, ["serve", "--config", probeConfigPath], {
    env: fixtureEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let problemDiagnostics = "";
  problemGateway.stderr.on("data", (chunk) => {
    problemDiagnostics = (problemDiagnostics + chunk).slice(-4000);
  });
  problemGatewayExit = new Promise((ok) => problemGateway.once("exit", ok));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (problemDiagnostics.includes("listening on")) break;
    assert.equal(problemGateway.exitCode, null, problemDiagnostics);
    await new Promise((ok) => setTimeout(ok, 100));
  }
  assert.match(problemDiagnostics, /listening on/);
  const problemContext = await browser.newContext();
  const problemPage = await problemContext.newPage();
  problemPage.on("pageerror", (error) => errors.push(error.message));
  await problemPage.goto(`${probeOrigin}/agent-connect/owner`);
  await problemPage.getByLabel("Owner passphrase").fill(password);
  await problemPage
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  assert.equal(await problemPage.locator(".runtime-problem").count(), 0);
  run(binary, ["egress", "stop", "--name", problemEgress]);
  problemEgressAllocated = false;
  const outageDeadline = Date.now() + 25000;
  while (Date.now() < outageDeadline) {
    await problemPage.reload();
    if (await problemPage.locator(".runtime-problem[role=status]").count())
      break;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  const banner = problemPage.locator(".runtime-problem[role=status]");
  assert.match(
    await banner.textContent(),
    /boxed runtime.*unavailable|health check.*stalled/i,
  );
  assert.match(await banner.textContent(), /agent-connect doctor/);
  assert.equal(
    await problemPage
      .getByRole("button", { name: "End session", exact: true })
      .count(),
    0,
  );
  await capture("runtime-problem", { target: problemPage });
  await problemContext.close();
  assert.deepEqual(errors, []);
  await writeFile(
    join(root, "report.json"),
    JSON.stringify(
      {
        status: "passed",
        states,
        viewports: views,
        pageErrors: errors,
        screenshots,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS ACP owner UI (${states.length} states × ${views.length} viewports; keyboard, touch, reflow, screenshots)`,
  );
  console.log(`Owner UI review artifacts: ${join(root, "report.json")}`);
} finally {
  async function stopGateway(child, exited) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    let timer;
    try {
      await Promise.race([
        exited,
        new Promise((ok) => {
          timer = setTimeout(() => {
            child.kill("SIGKILL");
            ok();
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  // Every owned process gets a cleanup attempt even if egress startup/stop fails.
  await runCleanupTasks([
    () => browser?.close(),
    () =>
      new Promise((ok, fail) =>
        application.close((error) => (error ? fail(error) : ok())),
      ),
    () => stopGateway(gateway, gatewayExit),
    () => stopGateway(problemGateway, problemGatewayExit),
    () => {
      if (problemEgressAllocated)
        run(binary, ["egress", "stop", "--name", problemEgress]);
    },
  ]);
}
