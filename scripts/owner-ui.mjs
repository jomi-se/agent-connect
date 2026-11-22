// Credential-free browser qualification of the gateway-owned authorization UI.
// Synthetic owner/factor state stays isolated; screenshots default to a temporary
// review root or are retained in OWNER_UI_SCREENSHOTS when explicitly requested.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { runCleanupTasks, stopFixtureChild } from "./test-fixture-cleanup.mjs";
import { gatewayTestBinary } from "./gateway-test-binary.mjs";
import {
  ownerCookieResolverRules,
  verifyOwnerCookies,
} from "./owner-cookie-browser.mjs";
import { requireBoxImage } from "./test-box-images.mjs";
import { verifyClientAddressPolicy } from "./client-address-fixture.mjs";
import { ownerTerminal } from "../deploy/gateway/test/clean-room/owner-terminal.mjs";
import { rootlessEnginePath } from "./rootless-engine-stub.mjs";
import { engine, engineEnv } from "./container-engine.mjs";
import { ownerPasskeys, passkeySignIn } from "./owner-passkey-browser.mjs";
import {
  nextTotpStep,
  setUpTotpInBrowser,
  totpCode,
  totpStep,
} from "./owner-totp.mjs";

const boxImage = requireBoxImage();
const repo = resolve(import.meta.dirname, "..");
const binary = await gatewayTestBinary({
  repository: repo,
  build: () => {
    const build = spawnSync(
      "cargo",
      ["build", "--locked", "--bin", "agent-connect"],
      { cwd: repo, encoding: "utf8" },
    );
    assert.equal(build.status, 0, build.stderr);
  },
});
const root = await mkdtemp(join(tmpdir(), "acp-owner-ui-"));
const screenshots = process.env.OWNER_UI_SCREENSHOTS
  ? resolve(process.env.OWNER_UI_SCREENSHOTS)
  : join(root, "screenshots");
await Promise.all(["home", "state"].map((name) => mkdir(join(root, name))));
await mkdir(screenshots, { recursive: true });
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
require("node:fs").writeFileSync(${JSON.stringify(join(root, "adapter.pid"))}, String(process.pid), { mode: 0o600 });
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
  ...engineEnv(),
  // setup's rootful-engine gate sees a rootless engine on any host.
  PATH: await rootlessEnginePath(root),
  HOME: join(root, "home"),
  XDG_STATE_HOME: join(root, "state"),
};
const password = "isolated-owner-browser-test";
const listener = net.createServer();
await new Promise((ok) => listener.listen(0, "127.0.0.1", ok));
const port = listener.address().port;
await new Promise((ok) => listener.close(ok));
// The owner's main address is a name, so it gets a passkey (Chromium's virtual
// authenticator: real WebAuthn and signatures, no device). The same gateway by
// bare IP address cannot have one and takes the TOTP path.
const origin = `http://localhost:${port}`;
const ipOrigin = `http://127.0.0.1:${port}`;
const ownerCookieName = `agent_connect_owner_${port}`;
const application = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(
    "<!doctype html><html lang=en><title>Test app</title><main><h1>Returned to app</h1></main></html>",
  );
});
await new Promise((ok) => application.listen(0, "127.0.0.1", ok));
const appOrigin = `http://127.0.0.1:${application.address().port}`;
const setup = await ownerTerminal(
  binary,
  [
    "setup",
    "--apply",
    "--non-interactive",
    "--no-service",
    "--box-image",
    boxImage,
    "--directory",
    join(root, "runtime"),
    "--harness",
    "codex",
    "--origin",
    origin,
  ],
  password,
  { env: fixtureEnv },
);
assert.equal(setup.code, 0, setup.stderr);
const configPath = join(root, "runtime/config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
// This first runtime uses a controlled ACP endpoint solely for owner session controls.
Object.assign(config, {
  boxed: false,
  mock_root: root,
  harness_home: undefined,
  listen: `127.0.0.1:${port}`,
  entry_points: [ipOrigin],
});
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
let gateway = spawn(binary, ["serve", "--config", configPath], {
  env: fixtureEnv,
  stdio: ["ignore", "ignore", "pipe"],
});
let diagnostics = "";
const auditLines = [];
let diagnosticRemainder = "";
function captureGatewayDiagnostics(chunk) {
  diagnostics = (diagnostics + chunk).slice(-4000);
  const lines = (diagnosticRemainder + chunk).split("\n");
  diagnosticRemainder = lines.pop();
  auditLines.push(
    ...lines.filter((line) => line.includes("owner_sign_in_failed")),
  );
}
gateway.stderr.on("data", captureGatewayDiagnostics);
let gatewayExit = new Promise((ok) => gateway.once("exit", ok));
const states = [];
const views = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "phone", width: 390, height: 844 },
  { name: "reflow", width: 320, height: 800 },
];
let browser;
let problemGateway;
let problemGatewayExit;
let problemProxy;
let preserveRoot = false;
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
if (process.env.OWNER_UI_SCREENSHOTS)
  console.log(`Owner UI screenshots: ${screenshots}`);
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (diagnostics.includes("listening on")) break;
    assert.equal(gateway.exitCode, null, diagnostics);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.match(diagnostics, /listening on/);
  browser = await chromium.launch({
    env: fixtureEnv,
    args: [
      `--host-resolver-rules=${ownerCookieResolverRules}`,
      "--no-proxy-server",
    ],
  });
  const ownerCookieChecks = await verifyOwnerCookies({
    browser,
    binary,
    root,
    fixtureEnv,
    password,
  });
  const clientAddressChecks = await verifyClientAddressPolicy({
    binary,
    root,
    fixtureEnv,
    password,
  });
  const context = await browser.newContext();
  const passkeys = ownerPasskeys();
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
        surfaceWidth: document.querySelector("main").getBoundingClientRect()
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
          .locator(
            "button, a, input:not([type=hidden]):not([type=radio]), label:has(input[type=radio]), summary",
          )
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
  const httpSignIn = await page.goto(owner);
  assert.equal(await httpSignIn.headerValue("strict-transport-security"), null);
  const anonymousCookies = await context.cookies(owner);
  assert.equal(anonymousCookies.length, 1);
  assert.equal(anonymousCookies[0].name, ownerCookieName);
  assert.equal(anonymousCookies[0].path, "/agent-connect");
  assert.equal(anonymousCookies[0].secure, false);
  assert.equal(anonymousCookies[0].httpOnly, true);
  assert.equal(anonymousCookies[0].sameSite, "Lax");
  await capture("sign-in", { compact: true });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.getByLabel("Passphrase", { exact: true }).evaluate((input) => {
    assertBrowser(
      input === document.activeElement,
      "Passphrase follows the brand link in keyboard order",
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
      .getByRole("button", { name: "Continue" })
      .evaluate((button) => button === document.activeElement),
    true,
  );
  const failedSignInCsrf = await page
    .locator('input[name="csrf_token"]')
    .inputValue();
  const wrongPassphrase = "deliberately-wrong-test-passphrase";
  await page.getByLabel("Passphrase", { exact: true }).fill(wrongPassphrase);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Sign-in failed" }).waitFor();
  await capture("sign-in-error", { compact: true });
  await page.goto(owner);
  await page.getByLabel("Passphrase", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  // No factor yet: the passphrase opens setup only, and setup offers a passkey.
  const createPasskey = page.getByRole("button", {
    name: "Create a passkey",
    exact: true,
  });
  await createPasskey.waitFor();
  await capture("setup-passkey", { compact: true });
  assert.equal(
    (await page.goto(owner)).url(),
    `${origin}/agent-connect/owner/setup`,
    "A setup session reaches nothing but setup",
  );
  await passkeys.use(page, () =>
    Promise.all([
      page.waitForURL(owner),
      page.getByRole("button", { name: "Create a passkey" }).click(),
    ]),
  );
  assert.deepEqual(passkeys.relyingParties(), ["localhost"]);
  await page
    .getByRole("heading", { name: "No apps yet", exact: true })
    .waitFor();
  const signedInCookies = await context.cookies(owner);
  assert.equal(signedInCookies.length, 1);
  assert.equal(signedInCookies[0].name, ownerCookieName);
  assert.equal(signedInCookies[0].path, "/agent-connect");
  assert.equal(signedInCookies[0].secure, false);
  assert.ok(signedInCookies[0].value.startsWith("owner_"));
  assert.ok(signedInCookies[0].value !== anonymousCookies[0].value);
  const signInHistory = page.getByRole("region", {
    name: "Sign-in security",
    exact: true,
  });
  await signInHistory.getByText("Wrong passphrase.", { exact: true }).waitFor();
  assert.ok((await signInHistory.innerText()).includes(origin));
  const auditPrivateValues = [
    password,
    wrongPassphrase,
    failedSignInCsrf,
    anonymousCookies[0].value,
    signedInCookies[0].value,
  ];
  const signInHistoryHtml = await signInHistory.innerHTML();
  for (const secret of auditPrivateValues)
    assert.ok(
      !signInHistoryHtml.includes(secret),
      "Sign-in history must not contain submitted secrets",
    );
  await capture("activity-empty");
  await page.getByRole("link", { name: "Security", exact: true }).click();
  await page.getByText("Passkey · this address", { exact: true }).waitFor();
  await page.getByText("Not set up", { exact: true }).waitFor();
  assert.ok(
    await page
      .getByRole("button", { name: "Revoke all", exact: true })
      .isDisabled(),
  );
  await capture("security");
  await page.getByRole("link", { name: "Gateway", exact: true }).click();
  await page
    .getByRole("heading", {
      name: "Access options when you approve an app",
      exact: true,
    })
    .waitFor();
  await page.getByText("Details and limits", { exact: true }).click();
  await page
    .getByText(/Deny-all and app-tools-only are not offered for Codex/)
    .waitFor();
  await capture("gateway");

  let pendingAuthorization;
  async function push({
    stress = false,
    state = "synthetic-visual-state",
    at = origin,
  } = {}) {
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
      resource: `${at}/acp`,
      response_type: "code",
      scope: "acp",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      authorization_details: JSON.stringify([{ type: "agent_connect", tools }]),
    });
    const reply = await fetch(`${at}/agent-connect/oauth/par`, {
      method: "POST",
      headers: { Origin: client },
      body: params,
    });
    assert.equal(reply.status, 201);
    const { request_uri } = await reply.json();
    return `${at}/agent-connect/oauth/authorize?${new URLSearchParams({ client_id: client, request_uri })}`;
  }
  // The bare IP address: no factor yet and no passkey possible. A failed
  // sign-in keeps the waiting request through the retry link, setup explains
  // the missing passkey, and TOTP set up there leads back to the request.
  const ipOwner = `${ipOrigin}/agent-connect/owner`;
  let ipTotpSecret = "";
  let lastIpTotpStep = 0;
  const recoveryContext = await browser.newContext();
  try {
    const recoveryPage = await recoveryContext.newPage();
    recoveryPage.on("pageerror", (error) => errors.push(error.message));
    await recoveryPage.goto(ipOwner);
    await recoveryPage.getByLabel("Passphrase", { exact: true }).waitFor();
    assert.equal(
      await recoveryPage
        .getByRole("region", { name: "Sign-in security", exact: true })
        .count(),
      0,
    );
    const recoveryState = "synthetic-sign-in-recovery-state";
    const originalRequest = new URL(
      await push({ state: recoveryState, at: ipOrigin }),
    );
    const waitingApp =
      "Sign in to review the request from The evening library.";
    await recoveryPage.goto(originalRequest.href);
    await recoveryPage.getByText(waitingApp, { exact: true }).waitFor();
    await recoveryPage
      .getByLabel("Passphrase", { exact: true })
      .fill("deliberately-wrong-recovery-passphrase");
    const [failedSignIn] = await Promise.all([
      recoveryPage.waitForResponse(
        (reply) =>
          reply.url() === `${ipOwner}/login` &&
          reply.request().method() === "POST",
      ),
      recoveryPage
        .getByRole("button", { name: "Continue", exact: true })
        .click(),
    ]);
    assert.equal(failedSignIn.status(), 401);
    await recoveryPage
      .getByRole("heading", { name: "Sign-in failed", exact: true })
      .waitFor();
    const retry = recoveryPage.getByRole("link", {
      name: "Return to sign-in",
      exact: true,
    });
    const retryUrl = new URL(await retry.getAttribute("href"), ipOrigin);
    assert.equal(retryUrl.origin, ipOrigin);
    assert.equal(retryUrl.pathname, "/agent-connect/owner/login");
    for (const key of ["client_id", "request_uri"])
      assert.equal(
        retryUrl.searchParams.get(key),
        originalRequest.searchParams.get(key),
      );
    // Follow the rendered recovery link, rather than reconstructing the request.
    await retry.click();
    await recoveryPage.getByText(waitingApp, { exact: true }).waitFor();
    await recoveryPage.getByLabel("Passphrase", { exact: true }).fill(password);
    await recoveryPage
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await recoveryPage
      .getByRole("heading", { name: "Set up an authenticator", exact: true })
      .waitFor();
    assert.match(
      await recoveryPage.locator("main").innerText(),
      /raw IP address/,
      "The IP address page says why there is no passkey and where to get one",
    );
    await capture("setup-ip-address", { compact: true, target: recoveryPage });
    await recoveryPage
      .getByRole("link", { name: "Use an authenticator app", exact: true })
      .click();
    await recoveryPage
      .getByRole("img", {
        name: "QR code for adding Agent Connect to an authenticator",
      })
      .waitFor();
    assert.equal(await recoveryPage.locator(".qr svg").count(), 1);
    await capture("authenticator-qr", { target: recoveryPage });
    const uri = await recoveryPage
      .getByRole("link", { name: "Open in authenticator app" })
      .getAttribute("href");
    const secret = new URL(uri).searchParams.get("secret");
    ipTotpSecret = secret;
    await recoveryContext.grantPermissions(
      ["clipboard-read", "clipboard-write"],
      { origin: ipOrigin },
    );
    const manual = recoveryPage.locator(".manual summary");
    await manual.click();
    await recoveryPage.getByText("Copied", { exact: true }).waitFor();
    assert.ok(
      (await recoveryPage.evaluate(() => navigator.clipboard.readText())) ===
        secret,
      "Manual setup click copies the complete unspaced key",
    );
    assert.equal(
      await recoveryPage.locator(".manual").getAttribute("open"),
      "",
    );
    await capture("authenticator-key-copied", { target: recoveryPage });
    await recoveryPage.emulateMedia({ reducedMotion: "reduce" });
    await manual.focus();
    await manual.press("Enter");
    assert.equal(
      await recoveryPage.locator(".manual").getAttribute("open"),
      null,
    );
    assert.equal(
      await recoveryPage
        .locator(".copy-status")
        .evaluate((status) => getComputedStyle(status).animationName),
      "none",
    );
    await recoveryPage.emulateMedia({ reducedMotion: "no-preference" });
    const enrollmentStep = totpStep();
    await recoveryPage
      .getByLabel("Code", { exact: true })
      .fill(totpCode(secret, enrollmentStep));
    await recoveryPage.getByRole("button", { name: "Turn on" }).click();
    // Enrolling leads back to the request that was waiting.
    await recoveryPage
      .getByRole("heading", {
        name: "Allow The evening library to use your agent?",
        exact: true,
      })
      .waitFor();
    assert.equal(
      await recoveryPage.locator('input[name="request_uri"]').inputValue(),
      originalRequest.searchParams.get("request_uri"),
    );
    await recoveryPage
      .getByRole("button", { name: "Deny", exact: true })
      .click();
    await recoveryPage.waitForURL(`${appOrigin}/callback?**`);
    const recoveredCallback = new URL(recoveryPage.url());
    assert.equal(recoveredCallback.origin, appOrigin);
    assert.equal(recoveredCallback.pathname, "/callback");
    assert.equal(recoveredCallback.searchParams.get("state"), recoveryState);
    assert.equal(recoveredCallback.searchParams.get("error"), "access_denied");
    assert.equal(recoveredCallback.searchParams.get("iss"), ipOrigin);
    assert.equal(recoveredCallback.searchParams.has("code"), false);
    // Each approval on a TOTP address takes a fresh code.
    await recoveryPage.goto(await push({ at: ipOrigin }));
    await recoveryPage.getByLabel("Authenticator code").waitFor();
    await capture("factor-consent", { target: recoveryPage });
    await recoveryPage
      .getByLabel("Authenticator code")
      .fill(totpCode(secret, enrollmentStep));
    await recoveryPage
      .getByRole("button", { name: "Approve", exact: true })
      .click();
    await recoveryPage
      .getByRole("heading", { name: "Authenticator code not accepted" })
      .waitFor();
    await capture("factor-error", { compact: true, target: recoveryPage });
    await recoveryPage.goto(await push({ at: ipOrigin }));
    const freshStep = await nextTotpStep(enrollmentStep);
    lastIpTotpStep = freshStep;
    await recoveryPage
      .getByLabel("Authenticator code")
      .fill(totpCode(secret, freshStep));
    await recoveryPage.getByLabel("Authenticator code").press("Enter");
    await recoveryPage.waitForURL(`${appOrigin}/**`);
    assert.ok(
      new URL(recoveryPage.url()).searchParams.get("code"),
      "Enter approves rather than denying consent",
    );
    // Revoke it there, so the main address's flow below starts with no grant.
    await recoveryPage.goto(ipOwner);
    await recoveryPage
      .getByRole("button", { name: "Revoke", exact: true })
      .click();
    await recoveryPage.getByText("revoked", { exact: true }).waitFor();
    await recoveryPage.goto(await push({ at: ipOrigin }));
    await recoveryPage
      .getByRole("button", { name: "Deny", exact: true })
      .click();
    await recoveryPage.waitForURL(`${appOrigin}/**`);
    await recoveryPage.goto(ipOwner);
    const [httpLogout] = await Promise.all([
      recoveryPage.waitForResponse(
        (reply) =>
          reply.url() === `${ipOwner}/logout` &&
          reply.request().method() === "POST",
      ),
      recoveryPage
        .getByRole("button", { name: "Sign out", exact: true })
        .click(),
    ]);
    assert.equal(
      await httpLogout.headerValue("set-cookie"),
      `${ownerCookieName}=; Path=/agent-connect; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
    await recoveryPage.getByLabel("Authenticator code").waitFor();
    const signedOutCookies = await recoveryContext.cookies(ipOwner);
    assert.equal(signedOutCookies.length, 1);
    assert.equal(signedOutCookies[0].name, ownerCookieName);
    assert.ok(signedOutCookies[0].value.startsWith("anonymous_"));
    await capture("factor-sign-in", { compact: true, target: recoveryPage });
  } finally {
    await recoveryContext.close();
  }
  // A browser without passkeys hears so when the button is pressed, and posts nothing.
  const noPasskeyContext = await browser.newContext();
  try {
    await noPasskeyContext.addInitScript(() => {
      delete window.PublicKeyCredential;
    });
    const noPasskeyPage = await noPasskeyContext.newPage();
    noPasskeyPage.on("pageerror", (error) => errors.push(error.message));
    let posted = false;
    noPasskeyPage.on("request", (request) => {
      if (request.method() === "POST") posted = true;
    });
    await noPasskeyPage.goto(`${owner}/login`);
    assert.equal(await noPasskeyPage.locator(".lede").count(), 0);
    await noPasskeyPage
      .getByRole("button", { name: "Sign in with your passkey", exact: true })
      .click();
    await noPasskeyPage
      .getByText("This browser can’t use passkeys.", { exact: true })
      .waitFor();
    assert.equal(posted, false);
  } finally {
    await noPasskeyContext.close();
  }
  const missingCookieContext = await browser.newContext();
  try {
    const missingCookiePage = await missingCookieContext.newPage();
    missingCookiePage.on("pageerror", (error) => errors.push(error.message));
    await missingCookiePage.goto(`${owner}/login`);
    const passkeyButton = missingCookiePage.getByRole("button", {
      name: "Sign in with your passkey",
      exact: true,
    });
    await passkeyButton.waitFor();
    await capture("passkey-sign-in", {
      compact: true,
      target: missingCookiePage,
    });
    const omittedCookie = (await missingCookieContext.cookies(owner)).find(
      ({ name }) => name === ownerCookieName,
    );
    assert.ok(omittedCookie);
    const csrf = await missingCookiePage
      .locator('input[name="csrf_token"]')
      .inputValue();
    await missingCookieContext.clearCookies();
    const [missingCookieReply] = await passkeys.use(missingCookiePage, () =>
      Promise.all([
        missingCookiePage.waitForResponse(
          (reply) =>
            reply.url() === `${owner}/login` &&
            reply.request().method() === "POST",
        ),
        passkeyButton.click(),
      ]),
    );
    assert.equal(missingCookieReply.status(), 403);
    assert.equal(
      (await missingCookieReply.request().allHeaders()).cookie,
      undefined,
    );
    await missingCookiePage
      .getByText(/^The sign-in session cookie was not sent\./)
      .waitFor();
    const diagnostic = await missingCookieReply.text();
    for (const secret of [password, omittedCookie.value, csrf])
      assert.ok(
        !diagnostic.includes(secret),
        "Cookie diagnostic must not echo credentials",
      );
    assert.equal(
      await missingCookiePage
        .getByRole("link", { name: "Return to sign-in", exact: true })
        .getAttribute("href"),
      "/agent-connect/owner/login",
    );
    const privateErrorMarker = "synthetic-private-request-field-marker";
    auditPrivateValues.push(privateErrorMarker, omittedCookie.value, csrf);
    const malformed = await missingCookieContext.request.post(
      `${owner}/login`,
      {
        headers: { Origin: origin },
        form: { [privateErrorMarker]: "synthetic-private-error-value" },
      },
    );
    assert.equal(malformed.status(), 400);
    auditPrivateValues.push("synthetic-private-error-value");
  } finally {
    await missingCookieContext.close();
  }
  const signInRecoveryChecks = {
    pendingRequestPreserved: true,
    missingCookieDiagnostic: true,
  };
  const consent = await push();
  await page.goto(owner);
  // The request whose code was refused on the IP address is still pending:
  // Activity lists it too, reviewed on the address it was made on.
  const elsewhere = page
    .locator("article.request")
    .filter({ hasText: `on ${ipOrigin}` });
  assert.ok(
    (
      await elsewhere
        .getByRole("link", { name: "Review", exact: true })
        .getAttribute("href")
    ).startsWith(`${ipOrigin}/agent-connect/oauth/authorize?`),
    "A request links to the address it was made on",
  );
  await page
    .locator("article.request")
    .filter({ hasNotText: `on ${ipOrigin}` })
    .getByRole("link", { name: "Review", exact: true })
    .waitFor();
  await capture("activity-pending");
  await page.goto(consent);
  const profiles = page.locator('input[type="radio"][name="profile"]');
  assert.deepEqual(
    await profiles.evaluateAll((inputs) => inputs.map((input) => input.value)),
    ["sandboxed", "read-only"],
  );
  const profile = page.locator('input[name="profile"][value="sandboxed"]');
  await profile.focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await page.locator('input[name="profile"][value="read-only"]').isChecked(),
    true,
  );
  await page.keyboard.press("ArrowUp");
  assert.equal(await profile.isChecked(), true);
  assert.equal(await page.locator("button").first().textContent(), "Approve");
  await capture("consent");
  const disclosure = page.locator(".tool-list summary").first();
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
  await passkeys.use(page, () =>
    Promise.all([
      page.waitForURL(`${appOrigin}/**`),
      page.getByRole("button", { name: "Approve", exact: true }).click(),
    ]),
  );
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
  await page.locator(".event--active").waitFor();
  await capture("activity-active");
  const endSession = page.getByRole("button", {
    name: "End session",
    exact: true,
  });
  await endSession.waitFor();
  await capture("activity-live");
  await endSession.focus();
  assert.equal(
    await endSession.evaluate((button) => button === document.activeElement),
    true,
  );
  const adapterPid = Number(await readFile(join(root, "adapter.pid"), "utf8"));
  assert.ok(Number.isInteger(adapterPid) && adapterPid > 0);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.keyboard.press("Enter"),
  ]);
  const endedStates = [];
  const cleanupDeadline = Date.now() + 25000;
  let runtimeGone = false;
  while (Date.now() < cleanupDeadline) {
    await page.goto(owner);
    const absent = (await page.locator(".event--live").count()) === 0;
    let adapterGone = false;
    try {
      process.kill(adapterPid, 0);
    } catch (error) {
      if (error.code === "ESRCH") adapterGone = true;
      else throw error;
    }
    if (absent && adapterGone) {
      endedStates.push("absent");
      runtimeGone = true;
      break;
    }
    const sessionRecords = await page
      .locator('form[action="/agent-connect/owner/sessions/end"]')
      .evaluateAll((forms) =>
        forms.map((form) => form.parentElement.textContent),
      );
    endedStates.push(
      sessionRecords.some((text) => /stopping/i.test(text))
        ? "stopping"
        : absent
          ? "awaiting-process-exit"
          : "present",
    );
    await new Promise((ok) => setTimeout(ok, 100));
  }
  assert.ok(
    runtimeGone,
    "owner end must remove the real runtime host and terminate its controlled adapter within 25 seconds",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "End session", exact: true })
      .count(),
    0,
  );
  await runtimePage.waitForFunction(
    () => window.consoleFixtureCloseCode === 4415,
  );
  assert.ok(
    await page.getByRole("button", { name: "Revoke", exact: true }).isVisible(),
    "ending a host retains its application grant",
  );
  await capture("ended-session-active-grant");
  await runtimePage.close();
  await page.getByRole("button", { name: "Revoke" }).click();
  await page.getByText("revoked", { exact: true }).waitFor();
  await capture("activity-revoked");
  await page.goto(await push());
  await passkeys.use(page, () =>
    Promise.all([
      page.waitForURL(`${appOrigin}/**`),
      page.getByRole("button", { name: "Approve", exact: true }).click(),
    ]),
  );
  await page.goto(`${owner}/security`);
  const revokeAll = page.getByRole("button", {
    name: "Revoke all",
    exact: true,
  });
  await revokeAll.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(owner);
  await page.goto(`${owner}/security`);
  assert.ok(
    await page
      .getByRole("button", { name: "Revoke all", exact: true })
      .isDisabled(),
  );
  await page.goto(owner);
  assert.equal(
    await page.getByRole("button", { name: "Revoke", exact: true }).count(),
    0,
  );
  await capture("all-grants-revoked");
  // Controlled stored history exercises expiry without waiting an hour or
  // changing the gateway's production clock.
  gateway.kill("SIGTERM");
  await gatewayExit;
  const authPath = join(
    resolve(dirname(configPath), config.state_dir),
    "auth/authorization.json",
  );
  const stored = JSON.parse(await readFile(authPath, "utf8"));
  Object.assign(stored.grants[0], {
    revoked: false,
    revoked_at: null,
    approved_at: Math.floor(Date.now() / 1000) - 3660,
    expires: Math.floor(Date.now() / 1000) - 60,
  });
  await writeFile(authPath, JSON.stringify(stored), { mode: 0o600 });
  diagnostics = "";
  diagnosticRemainder = "";
  gateway = spawn(binary, ["serve", "--config", configPath], {
    env: fixtureEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  gateway.stderr.on("data", captureGatewayDiagnostics);
  gatewayExit = new Promise((ok) => gateway.once("exit", ok));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (diagnostics.includes("listening on")) break;
    assert.equal(gateway.exitCode, null, diagnostics);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.match(diagnostics, /listening on/);
  await passkeySignIn(page, passkeys, { owner, password });
  await page.getByText("expired", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("region", { name: "Sign-in security", exact: true })
      .count(),
    0,
    "Sign-in history resets when the fixture gateway restarts",
  );
  await capture("activity-expired");
  await page.goto(await push({ stress: true }));
  await capture("long-app-origin-and-tool-names");
  await page.goto(owner);
  await capture("long-pending-origin");
  // Approve one app on the main address and one on the IP address, then remove
  // the IP address's factor on Security: only the IP address's grant is revoked.
  await page.goto(await push());
  await passkeys.use(page, () =>
    Promise.all([
      page.waitForURL(`${appOrigin}/**`),
      page.getByRole("button", { name: "Approve", exact: true }).click(),
    ]),
  );
  let ipRefreshToken = "";
  const ipGrantContext = await browser.newContext();
  try {
    const ipGrantPage = await ipGrantContext.newPage();
    ipGrantPage.on("pageerror", (error) => errors.push(error.message));
    await ipGrantPage.goto(ipOwner);
    const signInStep = await nextTotpStep(lastIpTotpStep);
    await ipGrantPage.getByLabel("Passphrase", { exact: true }).fill(password);
    await ipGrantPage
      .getByLabel("Authenticator code")
      .fill(totpCode(ipTotpSecret, signInStep));
    await ipGrantPage
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await ipGrantPage.waitForURL(ipOwner);
    await ipGrantPage.goto(await push({ at: ipOrigin }));
    const approveStep = await nextTotpStep(signInStep);
    await ipGrantPage
      .getByLabel("Authenticator code")
      .fill(totpCode(ipTotpSecret, approveStep));
    await ipGrantPage
      .getByRole("button", { name: "Approve", exact: true })
      .click();
    await ipGrantPage.waitForURL(`${appOrigin}/**`);
    const ipCode = new URL(ipGrantPage.url()).searchParams.get("code");
    assert.ok(ipCode, "IP address approval returns an authorization code");
    const exchanged = await fetch(`${ipOrigin}/agent-connect/oauth/token`, {
      method: "POST",
      headers: { Origin: appOrigin },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: ipCode,
        client_id: appOrigin,
        redirect_uri: pendingAuthorization.redirectUri,
        code_verifier: pendingAuthorization.verifier,
        resource: `${ipOrigin}/acp`,
      }),
    });
    assert.equal(exchanged.status, 200);
    ipRefreshToken = (await exchanged.json()).refresh_token;
  } finally {
    await ipGrantContext.close();
  }
  // Security: the IP address now has TOTP. Removing it takes a fresh
  // passkey assertion here, puts that address back to setup and revokes apps
  // approved there while keeping grants approved on the main address.
  await page.goto(`${owner}/security`);
  const ipRow = page.locator(".row").filter({ hasText: ipOrigin });
  await ipRow.getByText("Authenticator app", { exact: true }).waitFor();
  await page.getByText(/2 apps have access/).waitFor();
  await capture("security-addresses");
  await passkeys.use(page, () =>
    Promise.all([
      page.waitForResponse(
        (reply) =>
          reply.url() === `${owner}/factor/remove` &&
          reply.request().method() === "POST",
      ),
      ipRow.getByRole("button", { name: "Remove", exact: true }).click(),
    ]),
  );
  await page.waitForURL(`${owner}/security`);
  await ipRow.getByText("Not set up", { exact: true }).waitFor();
  await page.getByText(/1 app has access/).waitFor();
  const refreshedAfterRemoval = await fetch(
    `${ipOrigin}/agent-connect/oauth/token`,
    {
      method: "POST",
      headers: { Origin: appOrigin },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: ipRefreshToken,
        client_id: appOrigin,
        resource: `${ipOrigin}/acp`,
      }),
    },
  );
  assert.equal(
    refreshedAfterRemoval.status,
    400,
    "Removing an address's factor revokes grants approved on that address",
  );
  assert.equal((await refreshedAfterRemoval.json()).error, "invalid_grant");
  // A real, isolated boxed runtime with no agent sessions exercises health UI.
  // Remove only this runtime's network proxy; no provider credentials or login are used.
  const probeListener = net.createServer();
  await new Promise((ok) => probeListener.listen(0, "127.0.0.1", ok));
  const probePort = probeListener.address().port;
  await new Promise((ok) => probeListener.close(ok));
  const probeOrigin = `http://127.0.0.1:${probePort}`;
  const probeRuntime = join(root, "problem-runtime");
  const probeSetup = await ownerTerminal(
    binary,
    [
      "setup",
      "--apply",
      "--non-interactive",
      "--no-service",
      "--box-image",
      boxImage,
      "--directory",
      probeRuntime,
      "--harness",
      "codex",
      "--origin",
      probeOrigin,
      "--harness-home",
      join(root, "problem-harness-home"),
    ],
    password,
    { env: fixtureEnv, timeout: 60000 },
  );
  assert.equal(probeSetup.code, 0, probeSetup.stderr);
  const probeConfigPath = join(probeRuntime, "config.json");
  const probeConfig = JSON.parse(await readFile(probeConfigPath, "utf8"));
  probeConfig.listen = `127.0.0.1:${probePort}`;
  problemProxy = probeConfig.egress_container;
  await writeFile(probeConfigPath, JSON.stringify(probeConfig), {
    mode: 0o600,
  });
  problemGateway = spawn(binary, ["serve", "--config", probeConfigPath], {
    env: fixtureEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let problemDiagnostics = "";
  problemGateway.stderr.on("data", (chunk) => {
    problemDiagnostics = (problemDiagnostics + chunk).slice(-4000);
  });
  problemGatewayExit = new Promise((ok) => problemGateway.once("exit", ok));
  // The gateway starts its network proxy before it listens.
  for (let attempt = 0; attempt < 600; attempt++) {
    if (problemDiagnostics.includes("listening on")) break;
    assert.equal(problemGateway.exitCode, null, problemDiagnostics);
    await new Promise((ok) => setTimeout(ok, 100));
  }
  assert.match(problemDiagnostics, /listening on/);
  const problemContext = await browser.newContext();
  const problemPage = await problemContext.newPage();
  problemPage.on("pageerror", (error) => errors.push(error.message));
  await problemPage.goto(`${probeOrigin}/agent-connect/owner`);
  await problemPage.getByLabel("Passphrase", { exact: true }).fill(password);
  await problemPage
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await setUpTotpInBrowser(problemPage);
  assert.equal(await problemPage.locator(".runtime-problem").count(), 0);
  run(engine, ["rm", "--force", problemProxy]);
  const outageDeadline = Date.now() + 25000;
  while (Date.now() < outageDeadline) {
    await problemPage.reload();
    if (await problemPage.locator(".runtime-problem[role=status]").count())
      break;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  const banner = problemPage.locator(".runtime-problem[role=status]");
  assert.match(await banner.textContent(), /box runtime is not responding/i);
  assert.match(await banner.textContent(), /agent-connect doctor/);
  assert.equal(
    await problemPage
      .getByRole("button", { name: "End session", exact: true })
      .count(),
    0,
  );
  await capture("runtime-problem", { target: problemPage });
  // Exhaust only this final fixture's budget; the primary runtime stays untouched.
  const pauseContext = await browser.newContext();
  try {
    const pausePage = await pauseContext.newPage();
    pausePage.on("pageerror", (error) => errors.push(error.message));
    const probeOwner = `${probeOrigin}/agent-connect/owner`;
    const marker = "synthetic-audit-secret-marker";
    const started = Date.now();
    const submittedSecrets = [password, marker];
    for (let attempt = 0; attempt < 11; attempt++) {
      await pausePage.goto(`${probeOwner}/login`);
      submittedSecrets.push(
        await pausePage.locator('input[name="csrf_token"]').inputValue(),
      );
      await pausePage.getByLabel("Passphrase", { exact: true }).fill(marker);
      await pausePage.getByLabel("Authenticator code").fill("000000");
      const [failed] = await Promise.all([
        pausePage.waitForResponse(
          (reply) =>
            reply.url() === `${probeOwner}/login` &&
            reply.request().method() === "POST",
        ),
        pausePage.getByRole("button", { name: "Sign in", exact: true }).click(),
      ]);
      assert.equal(failed.status(), attempt < 10 ? 401 : 429);
    }
    await pausePage.goto(probeOwner);
    await pausePage.getByLabel("Passphrase", { exact: true }).waitFor();
    assert.equal(
      await pausePage
        .getByRole("region", { name: "Sign-in security", exact: true })
        .count(),
      0,
    );
    await problemPage.reload();
    await problemPage
      .getByRole("heading", { name: "No apps yet", exact: true })
      .waitFor();
    const history = problemPage.getByRole("region", {
      name: "Sign-in security",
      exact: true,
    });
    await history
      .getByText("Sign-in attempts were temporarily paused.", { exact: true })
      .waitFor();
    const pause = history
      .locator(".sign-in-pause")
      .filter({ hasText: "Sign-in paused" });
    assert.match(
      await pause.innerText(),
      /^Sign-in paused · try again in \d+ min$/,
    );
    const reset = Date.parse(
      await pause.locator("time").first().getAttribute("datetime"),
    );
    assert.ok(
      reset >= started + 890000 && reset <= Date.now() + 900000,
      "Active sign-in pause shows its actual fifteen-minute reset window",
    );
    assert.equal(await history.locator(".sign-in-failure").count(), 11);
    const historyHtml = await history.innerHTML();
    for (const secret of submittedSecrets)
      assert.ok(
        !historyHtml.includes(secret),
        "Failure history must not expose submitted secrets",
      );
    await capture("sign-in-paused", { target: problemPage });
  } finally {
    await pauseContext.close();
  }
  await problemContext.close();
  for (const code of [
    "invalid_passphrase",
    "missing_session_cookie",
    "invalid_request",
  ])
    assert.ok(
      auditLines.some((line) => line.includes(code)),
      `Default gateway logger must emit ${code} sign-in audit events`,
    );
  for (const secret of auditPrivateValues)
    assert.ok(
      auditLines.every((line) => !line.includes(secret)),
      "Sign-in audit logs must not contain submitted secrets or raw error markers",
    );
  const signInAuditChecks = {
    ownerOnlyHistory: true,
    secretValuesExcluded: true,
    defaultLoggerEmitsAudit: true,
    restartClearsHistory: true,
    exhaustedBudgetPause: true,
  };
  assert.deepEqual(errors, []);
  await writeFile(
    join(root, "report.json"),
    JSON.stringify(
      {
        status: "passed",
        ownerCookieChecks,
        clientAddressChecks,
        signInRecoveryChecks,
        signInAuditChecks,
        states,
        sessionEndCleanup: {
          observed: endedStates,
          adapterTerminated: runtimeGone,
        },
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
} catch (error) {
  // A nested fixture whose child may still run owns this retention decision.
  preserveRoot =
    typeof error?.retainedDirectory === "string" &&
    error.retainedDirectory.length > 0;
  throw error;
} finally {
  const stopGateway = (child, exited) => stopFixtureChild(child, { exited });
  // Every owned process gets a cleanup attempt even if one of them fails.
  await runCleanupTasks([
    () => browser?.close(),
    () =>
      new Promise((ok, fail) =>
        application.close((error) => (error ? fail(error) : ok())),
      ),
    () => stopGateway(gateway, gatewayExit),
    () => stopGateway(problemGateway, problemGatewayExit),
    // A gateway removes its proxy when it stops; one that did not stop cleanly
    // leaves it, and on Podman its keepalive.
    () => {
      if (problemProxy)
        spawnSync(
          engine,
          ["rm", "--force", problemProxy, `${problemProxy}-keepalive`],
          { env: fixtureEnv },
        );
    },
  ]);
  // Stop all users of the private root before deleting their files. If cleanup
  // fails, retain the root for recovery rather than race a still-running child.
  if (!preserveRoot)
    for (const name of await readdir(root)) {
      if (name === "screenshots" || name === "report.json") continue;
      await rm(join(root, name), { recursive: true, force: true });
    }
}
