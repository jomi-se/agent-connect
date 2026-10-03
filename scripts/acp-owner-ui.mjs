// Credential-free browser qualification of the gateway-owned authorization UI.
// Screenshots and synthetic owner/factor state stay in a private temporary root.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const repo = resolve(import.meta.dirname, "..");
const root = await mkdtemp(join(tmpdir(), "acp-owner-ui-"));
const screenshots = join(root, "screenshots");
await Promise.all(
  ["home", "state", "screenshots"].map((name) => mkdir(join(root, name))),
);
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
// Only HTTP owner/OAuth pages are exercised. No harness or Docker is invoked.
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
  async function capture(name, { compact = false } = {}) {
    for (const view of views) {
      await page.setViewportSize({ width: view.width, height: view.height });
      const geometry = await page.evaluate(() => ({
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
        for (const target of await page
          .locator("button, select, input:not([type=hidden]), summary")
          .all()) {
          if (!(await target.isVisible())) continue;
          const box = await target.boundingBox();
          assert.ok(
            box.height >= 44,
            `${name} touch target is shorter than 44px`,
          );
        }
      }
      await page.screenshot({
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
  await page.getByRole("heading", { name: "Application access" }).waitFor();
  await page.getByRole("group", { name: "Access summary" }).waitFor();
  await capture("empty-console");

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
  await page.goto(owner);
  await page.getByText("Active", { exact: true }).last().waitFor();
  await capture("active-grant");
  await page.getByRole("button", { name: "Revoke access" }).click();
  await page.getByText("Revoked", { exact: true }).waitFor();
  await capture("revoked-grant");
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
  await browser?.close();
  await new Promise((ok) => application.close(ok));
  gateway.kill("SIGTERM");
  let timeout;
  await Promise.race([
    gatewayExit,
    new Promise((ok) => {
      timeout = setTimeout(() => {
        gateway.kill("SIGKILL");
        ok();
      }, 5000);
    }),
  ]);
  clearTimeout(timeout);
}
