// Runs inside a disposable container with no checkout and no SDK build outputs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  copyFile,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { chromium } from "playwright";

const work = process.env.ACP_CLEAN_WORK;
const suffix = process.env.ACP_CLEAN_SUFFIX;
assert.ok(
  work?.startsWith("/tmp/acp-clean-room-"),
  "Run directory must be a dedicated host-mounted test directory",
);
assert.match(suffix, /^[a-z0-9]+$/);
const artifacts = "/artifacts";
const sample = join(work, "sample");
const runtime = join(work, "operator");
const install = join(work, "install");
const modelName = `acp-clean-model-${suffix}`;
const egressName = `acp-clean-egress-${suffix}`;
const sessionImage = process.env.ACP_SESSION_IMAGE;
const services = new Set();
const resources = { containers: [], networks: [] };
const report = { packed: {}, checks: [] };
let browser;
async function recordResources() {
  await writeFile(join(work, "resources.json"), JSON.stringify(resources), {
    mode: 0o600,
  });
}
async function commandResult(bin, args, options = {}) {
  const child = spawn(bin, args, {
    cwd: work,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => {
    stdout = (stdout + bytes).slice(-16000);
  });
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes).slice(-8000);
  });
  return await new Promise((ok, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => ok({ code, stdout, stderr }));
  });
}
async function command(bin, args, options = {}) {
  const result = await commandResult(bin, args, options);
  if (result.code !== 0)
    throw new Error(
      `${bin} ${args[0]} failed (${result.code})\n${result.stdout}${result.stderr}`,
    );
  return (result.stdout + result.stderr).slice(-8000);
}
function jsonResult(result, label) {
  assert.ok(
    result.code === 0 || result.code === 1,
    `${label}: unexpected exit ${result.code}\n${result.stderr}`,
  );
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `${label}: expected JSON output\n${result.stdout}${result.stderr}`,
    );
  }
}

function service(bin, args, options = {}) {
  const child = spawn(bin, args, {
    cwd: work,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  services.add(child);
  let tail = "";
  child.stdout.on("data", (bytes) => {
    tail = (tail + bytes).slice(-8000);
  });
  child.stderr.on("data", (bytes) => {
    tail = (tail + bytes).slice(-8000);
  });
  child.on("error", (error) => {
    tail += String(error);
  });
  child.tail = () => tail;
  return child;
}
async function stop(child) {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise((ok) => {
    child.once("exit", ok);
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      ok();
    }, 3000).unref();
  });
}
async function port() {
  const server = createServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const value = server.address().port;
  await new Promise((ok) => server.close(ok));
  return value;
}
const delay = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function ready(url, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(child.tail());
    try {
      await fetch(url);
      return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Service failed to start: ${url}\n${child.tail()}`);
}
function isNativeConversationTitle(entry) {
  // The pinned real Codex runtime generates titles after the ACP turn settles.
  // Recognize that exact maintenance task and its title-only response schema;
  // neither model names nor absence of application tools identify a replay.
  const format = entry.body?.text?.format;
  const schema = format?.schema;
  const user = entry.body?.input?.filter((item) => item.role === "user").at(-1);
  const text = Array.isArray(user?.content)
    ? user.content
        .filter((part) => part.type === "input_text")
        .map((part) => part.text)
        .join("")
    : user?.content;
  return (
    typeof text === "string" &&
    text.startsWith(
      "Your task is to generate a very short title for a conversation based on the user's first message.",
    ) &&
    format?.type === "json_schema" &&
    format.strict === true &&
    schema?.type === "object" &&
    schema.additionalProperties === false &&
    JSON.stringify(schema.required) === '["title"]' &&
    JSON.stringify(Object.keys(schema.properties ?? {})) === '["title"]' &&
    schema.properties.title?.type === "string"
  );
}
async function modelRequests() {
  const content = await readFile(join(work, "logs/model.jsonl"), "utf8").catch(
    () => "",
  );
  const requests = content
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((entry) => entry.path === "/v1/responses");
  report.nativeConversationTitleRequests = requests.filter(
    isNativeConversationTitle,
  ).length;
  return requests.filter((entry) => !isNativeConversationTitle(entry));
}
async function cleanSessionResources() {
  const ids = (
    await readdir(join(runtime, "state/sessions")).catch(() => [])
  ).filter((id) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id));
  const info = await command("docker", ["inspect", modelName])
    .then(JSON.parse)
    .catch(() => []);
  // A gateway may detach peers before removing its network. The private state
  // directory records every host created by this run, including detached hosts.
  const networks = new Set([
    ...ids.map((id) => `acp-sess-net-${id}`),
    ...Object.keys(info[0]?.NetworkSettings?.Networks ?? {}).filter((name) =>
      name.startsWith("acp-sess-net-"),
    ),
  ]);
  for (const id of ids)
    await command("docker", ["rm", "-f", `acp-sess-${id}`]).catch(() => {});
  for (const network of networks) {
    const attached = await command("docker", ["network", "inspect", network])
      .then(JSON.parse)
      .catch(() => []);
    for (const container of Object.values(attached[0]?.Containers ?? {})) {
      if (container.Name.startsWith("acp-sess-"))
        await command("docker", ["rm", "-f", container.Name]).catch(() => {});
    }
    for (const name of [modelName, egressName])
      await command("docker", [
        "network",
        "disconnect",
        "--force",
        network,
        name,
      ]).catch(() => {});
    await command("docker", ["network", "rm", network]).catch(() => {});
  }
  const leftover = [];
  for (const id of ids) {
    for (const [kind, name] of [
      ["network", `acp-sess-net-${id}`],
      ["container", `acp-sess-${id}`],
    ]) {
      if (
        await command("docker", [kind, "inspect", name]).then(
          () => true,
          () => false,
        )
      )
        leftover.push(name);
    }
  }
  assert.deepEqual(
    leftover,
    [],
    "Owned session resources remain after cleanup",
  );
  return {
    ownedSessionHosts: ids.length,
    leftoverOwnedSessionResources: leftover.length,
  };
}
try {
  assert.equal(process.versions.node.split(".")[0], "24");
  assert.ok(Number(process.versions.node.split(".")[1]) >= 15);
  const release = JSON.parse(
    await readFile(join(artifacts, "release.json"), "utf8"),
  );
  assert.match(release.version, /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i);
  report.version = release.version;
  for (const filename of (await readdir(artifacts)).filter((filename) =>
    filename.endsWith(".tgz"),
  )) {
    const expected = release.artifacts?.[filename];
    assert.ok(expected, `${filename}: missing release checksum`);
    const bytes = await readFile(join(artifacts, filename));
    assert.equal(
      bytes.length,
      expected.size,
      `${filename}: release size mismatch`,
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected.sha256,
      `${filename}: release checksum mismatch`,
    );
  }
  report.checks.push(
    "release manifest size and SHA256 validation before installation",
  );
  for (const directory of [sample, install, join(work, "logs")])
    await mkdir(directory, { mode: 0o700 });
  const packages = new Map();
  for (const file of (await readdir(artifacts)).filter(
    (file) => file.endsWith(".tgz") && file !== "acp-chat-sample.tgz",
  )) {
    const metadata = JSON.parse(
      await command("tar", [
        "-xOf",
        join(artifacts, file),
        "package/package.json",
      ]),
    );
    if (packages.has(metadata.name))
      throw new Error(`Duplicate packed package: ${metadata.name}`);
    packages.set(metadata.name, { file: join(artifacts, file), metadata });
  }
  for (const name of [
    "@open-agent-connect/gateway",
    `@open-agent-connect/gateway-linux-${process.arch}`,
    "@open-agent-connect/web",
  ]) {
    const packed = packages.get(name);
    assert.ok(packed, `Missing packed ${name}`);
    assert.equal(
      packed.metadata.version,
      name === "@open-agent-connect/web" ? release.sdkVersion : release.version,
    );
    report.packed[name] = packed.metadata.version;
  }
  const gatewayPackage = packages.get("@open-agent-connect/gateway");
  const binaryPackage = packages.get(
    `@open-agent-connect/gateway-linux-${process.arch}`,
  );
  const sdkPackage = packages.get("@open-agent-connect/web");
  assert.deepEqual(
    gatewayPackage.metadata.agentConnect?.adapterVersions,
    release.adapterVersions,
    "Packed adapter pins disagree with release manifest",
  );
  await writeFile(
    join(install, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await command(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      gatewayPackage.file,
      binaryPackage.file,
    ],
    { cwd: install },
  );
  const gateway = join(install, "node_modules/.bin/agent-connect");
  assert.equal(
    (await command(gateway, ["--version"])).trim(),
    `agent-connect ${release.version}`,
  );
  await command("tar", [
    "-xzf",
    join(artifacts, "acp-chat-sample.tgz"),
    "--strip-components=1",
    "-C",
    sample,
  ]);
  const manifest = JSON.parse(
    await readFile(join(sample, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "agent-connect-acp-chat-sample");
  assert.equal(manifest.version, release.version);
  assert.ok(
    (await readFile(join(sample, "main.jsx"), "utf8")).includes(
      'from "@open-agent-connect/web"',
    ),
  );
  manifest.dependencies["@open-agent-connect/web"] = `file:${sdkPackage.file}`;
  await writeFile(join(sample, "package.json"), JSON.stringify(manifest));
  await command(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: sample },
  );
  // Resolve the installed public root export; no SDK source or aliases enter this build.
  const resolved = await command(
    "node",
    [
      "--input-type=module",
      "-e",
      'console.log(import.meta.resolve("@open-agent-connect/web"))',
    ],
    { cwd: sample },
  );
  assert.ok(
    resolved.includes("/node_modules/@open-agent-connect/web/dist/index.js"),
  );
  await command("npm", ["run", "build"], { cwd: sample });
  report.checks.push(
    "packed launcher, platform binary, SDK public export and standalone sample build",
  );
  const appPort = await port();
  const gatewayPort = await port();
  const relayPort = await port();
  const controlPort = await port();
  const origin = `http://127.0.0.1:${appPort}`;
  const publicGateway = `http://127.0.0.1:${relayPort}`;
  const ownerPassphrase = `disposable-owner-${suffix}-acceptance-only`;
  const passphraseFile = join(work, "owner-passphrase.txt");
  await writeFile(passphraseFile, ownerPassphrase, { mode: 0o600 });
  const preview = service(
    "npm",
    ["run", "preview", "--", "--port", String(appPort)],
    { cwd: sample },
  );
  await ready(origin, preview);
  const setupArgs = [
    "setup",
    "--directory",
    runtime,
    "--harness",
    "codex",
    "--origin",
    publicGateway,
    "--owner-passphrase-file",
    passphraseFile,
    "--listen",
    `127.0.0.1:${gatewayPort}`,
    "--session-image",
    sessionImage,
    "--egress-container",
    egressName,
    "--no-service",
  ];
  const setupPlanResult = await commandResult(gateway, [
    ...setupArgs,
    "--json",
  ]);
  assert.equal(setupPlanResult.code, 0, setupPlanResult.stderr);
  const setupPlan = jsonResult(setupPlanResult, "setup plan");
  assert.equal(setupPlan.directory, runtime);
  assert.equal(setupPlan.config, join(runtime, "config.json"));
  assert.equal(setupPlan.existing, false);
  assert.equal(setupPlan.harness, "codex");
  assert.equal(setupPlan.origin, publicGateway);
  assert.equal(setupPlan.login, false, "planning never invokes provider login");
  assert.equal(setupPlan.service, false);
  assert.ok(Array.isArray(setupPlan.steps) && setupPlan.steps.length > 0);
  await assert.rejects(stat(runtime), { code: "ENOENT" });
  report.checks.push(
    "artifact-installed setup JSON plans without creating runtime or provider login state",
  );
  // Keep cleanup ownership before application in case setup fails after egress creation.
  resources.containers.push(egressName);
  await recordResources();
  const appliedSetup = await commandResult(gateway, [
    ...setupArgs,
    "--apply",
    "--non-interactive",
    "--json",
  ]);
  assert.equal(appliedSetup.code, 0, appliedSetup.stderr);
  assert.equal(jsonResult(appliedSetup, "setup apply").login, false);
  const rerunPlanResult = await commandResult(gateway, [
    ...setupArgs,
    "--json",
  ]);
  assert.equal(rerunPlanResult.code, 0, rerunPlanResult.stderr);
  assert.equal(jsonResult(rerunPlanResult, "setup rerun plan").existing, true);
  report.checks.push(
    "artifact-installed setup applies synthetic owner initialization non-interactively without provider login and preserves owner/runtime state across applied reruns",
  );
  assert.equal((await stat(join(runtime, "config.json"))).mode & 0o077, 0);
  await assert.rejects(stat(join(runtime, "grant.json")), { code: "ENOENT" });
  const operatorConfigBytes = await readFile(
    join(runtime, "config.json"),
    "utf8",
  );
  const operatorConfig = JSON.parse(operatorConfigBytes);
  const ownerStatePath = join(runtime, "state/auth/authorization.json");
  const originalOwnerState = await readFile(ownerStatePath, "utf8");
  const resumedSetup = await commandResult(gateway, [
    ...setupArgs,
    "--apply",
    "--non-interactive",
    "--json",
  ]);
  assert.equal(resumedSetup.code, 0, resumedSetup.stderr);
  assert.equal(jsonResult(resumedSetup, "setup apply rerun").existing, true);
  assert.equal(
    await readFile(join(runtime, "config.json"), "utf8"),
    operatorConfigBytes,
    "setup rerun preserves runtime configuration",
  );
  assert.equal(
    await readFile(ownerStatePath, "utf8"),
    originalOwnerState,
    "setup rerun preserves synthetic owner and issuer state",
  );
  assert.ok(operatorConfig.harness_home.startsWith(work + "/"));
  assert.equal((await stat(operatorConfig.harness_home)).mode & 0o077, 0);
  assert.equal(operatorConfig.public_url, publicGateway);
  report.checks.push(
    "normal owner bootstrap issues no static application grant",
  );
  const serviceArgs = [
    "service",
    "--config",
    join(runtime, "config.json"),
    "--manager",
    "systemd",
  ];
  await command(gateway, [...serviceArgs, "install", "--offline"]);
  const unit = join(
    process.env.XDG_CONFIG_HOME ?? join(process.env.HOME, ".config"),
    "systemd/user/agent-connect.service",
  );
  const unitContent = await readFile(unit, "utf8");
  assert.match(unitContent, /^\[Service\]$/m);
  assert.match(unitContent, /^ExecStart=.*serve.*--config/m);
  assert.ok(unitContent.includes(join(runtime, "config.json")));
  assert.ok(
    unitContent.includes(install + "/node_modules/"),
    "service launches the installed artifact",
  );
  assert.ok(
    !unitContent.includes(ownerPassphrase) &&
      !unitContent.includes(passphraseFile),
  );
  assert.equal((await stat(unit)).mode & 0o077, 0);
  const offlineVerify = await commandResult("systemd-analyze", [
    "verify",
    unit,
  ]).catch((error) => ({
    missing: error.code === "ENOENT",
    stderr: error.message,
  }));
  if (offlineVerify.missing) {
    report.serviceOfflineVerification =
      "systemd-analyze unavailable; installed unit structure and artifact paths verified";
  } else {
    assert.equal(offlineVerify.code, 0, offlineVerify.stderr);
    report.serviceOfflineVerification =
      "systemd-analyze verify passed without a user manager";
  }
  const managerProbe = await commandResult("systemctl", [
    "--user",
    "show-environment",
  ]).catch((error) => ({ code: 1, stderr: error.message }));
  if (managerProbe.code === 0) {
    await command(gateway, [...serviceArgs, "install"]);
    await command(gateway, [...serviceArgs, "start"]);
    await command(gateway, [...serviceArgs, "status"]);
    await command(gateway, [...serviceArgs, "logs", "--lines", "20"]);
    await command(gateway, [...serviceArgs, "stop"]);
    await command(gateway, [...serviceArgs, "uninstall"]);
    report.checks.push(
      "artifact-installed user service install/start/status/logs/stop/uninstall lifecycle with an available isolated user manager",
    );
  } else {
    for (const action of [
      "install",
      "start",
      "stop",
      "status",
      "logs",
      "uninstall",
    ]) {
      const result = await commandResult(gateway, [
        ...serviceArgs,
        action,
        ...(action === "logs" ? ["--lines", "20"] : []),
      ]);
      if (action === "logs" && result.code === 0) {
        assert.ok(
          result.stdout.length <= 16000,
          "offline journal output is bounded",
        );
        continue;
      }
      assert.equal(
        result.code,
        1,
        `${action}: unavailable user manager must fail clearly\n${result.stdout}${result.stderr}`,
      );
      assert.match(
        result.stderr,
        /user manager|user service manager|run systemctl|run launchctl|run journalctl|supervisor|not installed/i,
      );
    }
    await command(gateway, [...serviceArgs, "uninstall", "--offline"]);
    report.checks.push(
      "artifact-installed service operations report unsupported user-manager state with repair guidance; offline install/verify/uninstall preserves private runtime",
    );
  }
  await assert.rejects(stat(unit), { code: "ENOENT" });
  assert.equal(
    await readFile(join(runtime, "config.json"), "utf8"),
    operatorConfigBytes,
    "service management preserves runtime configuration",
  );

  await copyFile(
    "/opt/acceptance/mock-model.mjs",
    join(work, "mock-model.mjs"),
  );
  const baseNetwork = `${modelName}-base`;
  resources.networks.push(baseNetwork);
  await recordResources();
  await command("docker", ["network", "create", "--internal", baseNetwork]);
  resources.containers.push(modelName);
  await recordResources();
  await command("docker", [
    "run",
    "-d",
    "--name",
    modelName,
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--network",
    baseNetwork,
    "--entrypoint",
    "node",
    "--mount",
    `type=bind,src=${join(work, "mock-model.mjs")},dst=/fixture.mjs,readonly`,
    "--mount",
    `type=bind,src=${join(work, "logs")},dst=/log`,
    "-e",
    "MOCK_HOST=0.0.0.0",
    "-e",
    "MOCK_PORT=18931",
    "-e",
    "MOCK_LOG=/log/model.jsonl",
    sessionImage,
    "/fixture.mjs",
  ]);
  await command(gateway, [
    "egress",
    "start",
    "--name",
    egressName,
    "--session-image",
    sessionImage,
  ]);
  // Repeat the installed CLI operation to prove it recognizes its own hardened peer.
  await command(gateway, [
    "egress",
    "start",
    "--name",
    egressName,
    "--session-image",
    sessionImage,
  ]);
  report.checks.push(
    "installed egress start creates and reuses its hardened owned runtime peer",
  );
  const gatewayService = service(
    gateway,
    [
      "serve",
      "--config",
      join(runtime, "config.json"),
      "--mock-root",
      work,
      "--mock-container",
      modelName,
      "--max-sessions",
      "1",
    ],
    { env: { ...process.env, AGENT_CONNECT_TEST_ROOT: work } },
  );
  await ready(`http://127.0.0.1:${gatewayPort}`, gatewayService);
  const doctorResult = await commandResult(gateway, [
    "doctor",
    "--config",
    join(runtime, "config.json"),
    "--json",
  ]);
  const diagnosis = jsonResult(doctorResult, "doctor");
  assert.equal(typeof diagnosis.ok, "boolean");
  assert.ok(Array.isArray(diagnosis.checks) && diagnosis.checks.length > 0);
  assert.equal(diagnosis.checks[0].code, "config_valid");
  assert.equal(diagnosis.checks[0].status, "pass");
  for (const check of diagnosis.checks) {
    assert.match(check.code, /^[a-z][a-z0-9_]*$/);
    assert.ok(["pass", "warn", "fail"].includes(check.status));
    assert.equal(typeof check.message, "string");
    if (check.status !== "pass")
      assert.ok(
        typeof check.fix === "string" && check.fix.length > 0,
        `${check.code}: actionable repair required`,
      );
  }
  assert.equal(JSON.stringify(diagnosis).includes(ownerPassphrase), false);
  report.doctor = {
    ok: diagnosis.ok,
    checks: diagnosis.checks.map(({ code, status }) => ({ code, status })),
  };
  report.checks.push(
    "artifact-installed doctor emits stable JSON checks and actionable fixes without reading provider credentials",
  );

  const relay = service("node", ["/opt/acceptance/relay.mjs"], {
    env: {
      ...process.env,
      RELAY_TARGET: String(gatewayPort),
      RELAY_LISTEN: String(relayPort),
      RELAY_CONTROL: String(controlPort),
    },
  });
  await ready(`http://127.0.0.1:${controlPort}/stats`, relay);
  browser = await chromium.launch({
    headless: true,
    channel: "chromium",
    args: ["--no-sandbox"],
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
  });
  async function appPage(context) {
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__pageRestorations = [];
      window.addEventListener("pageshow", (event) =>
        window.__pageRestorations.push(event.persisted),
      );
    });
    page.setDefaultTimeout(60000);
    page.on("response", async (response) => {
      if (
        response.url().startsWith(`${publicGateway}/agent-connect/oauth/`) &&
        response.status() >= 400
      ) {
        const data = await response.json().catch(() => ({}));
        report.authorizationFailures ??= [];
        report.authorizationFailures.push({
          status: response.status(),
          error: data.error,
        });
      }
    });
    page.on("pageerror", (error) => {
      report.pageErrors ??= [];
      report.pageErrors.push(error.message);
    });
    await page.goto(origin);
    return page;
  }
  async function ownerSignIn(page) {
    const password = page.locator('input[name="passphrase"]');
    await password.waitFor({ state: "visible" });
    await password.fill(ownerPassphrase);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  async function requestApproval(page, decision = "Approve") {
    await page.locator("#gateway-url").fill(publicGateway);
    const popup = page.waitForEvent("popup");
    await page.locator("#connect").click();
    const owner = await popup;
    try {
      await owner.waitForURL((url) => url.origin === publicGateway);
    } catch (error) {
      await page
        .waitForFunction(
          () => document.getElementById("error").textContent,
          null,
          { timeout: 2000 },
        )
        .catch(() => {});
      const failure = await page.locator("#error").evaluate((node) => ({
        code: node.dataset.code,
        message: node.textContent,
      }));
      report.pairingFailure = failure;
      throw new Error(
        `${error.message}\nApplication pairing ${failure.code ?? "unknown"}: ${failure.message}`,
      );
    }
    await owner
      .locator('input[name="passphrase"], button[value="approve"]')
      .first()
      .waitFor({ state: "visible" });
    if (await owner.locator('input[name="passphrase"]').count())
      await ownerSignIn(owner);
    await owner.getByRole("button", { name: decision, exact: true }).waitFor();
    const consent = await owner.locator("body").textContent();
    assert.ok(
      consent.includes(origin),
      "Gateway consent names the exact application origin",
    );
    for (const tool of ["read_passage", "highlight", "ask_reader"])
      assert.ok(consent.includes(tool), `Gateway consent includes ${tool}`);
    await owner.locator('select[name="duration"]').selectOption("3600");
    if (decision === "Approve")
      await owner
        .getByLabel("Restricted profile", { exact: true })
        .selectOption("read-only");
    await owner.getByRole("button", { name: decision, exact: true }).click();
    return owner;
  }
  async function connectPage() {
    const context = await browser.newContext();
    const page = await appPage(context);
    await requestApproval(page);
    await page.waitForFunction(
      () =>
        !document.getElementById("chat-input").disabled ||
        document.getElementById("error").textContent,
    );
    const connection = await page.evaluate(() => ({
      disabled: document.getElementById("chat-input").disabled,
      code: document.getElementById("error").dataset.code,
      message: document.getElementById("error").textContent,
    }));
    if (connection.disabled) report.connectionFailure = connection;
    assert.equal(
      connection.disabled,
      false,
      `Application connection failed: ${JSON.stringify(connection)}`,
    );
    assert.ok(!new URL(page.url()).searchParams.has("code"));
    assert.equal(await page.locator("#grant-file, #grant-token").count(), 0);
    return page;
  }
  const ownerUrl = `${publicGateway}/agent-connect/owner`;
  async function ownerPage(app) {
    const page = await app.context().newPage();
    await page.goto(ownerUrl);
    if (await page.getByLabel("Owner passphrase", { exact: true }).count())
      await ownerSignIn(page);
    await page
      .getByRole("heading", {
        name: "Application access",
        exact: true,
        level: 1,
      })
      .waitFor();
    return page;
  }
  const ownedHostSessions = new Map();
  async function waitNoLiveSessions(page, containerId) {
    const deadline = Date.now() + 25000;
    const observed = [];
    while (Date.now() < deadline) {
      await page.goto(ownerUrl);
      if (await page.getByText("No live sessions", { exact: true }).count()) {
        const container = await commandResult("docker", [
          "inspect",
          "--format",
          "{{.Id}}",
          containerId,
        ]);
        assert.equal(
          container.code,
          1,
          "owner end removes the owned session container",
        );
        assert.match(container.stderr, /No such/i);
        const network = await commandResult("docker", [
          "network",
          "inspect",
          `acp-sess-net-${ownedHostSessions.get(containerId)}`,
        ]);
        assert.equal(
          network.code,
          1,
          "owner end removes the owned session network",
        );
        assert.match(network.stderr, /No such|not found/i);
        observed.push("absent");
        (report.ownerSessionCleanup ??= []).push({
          observed,
          containerRemoved: true,
          networkRemoved: true,
        });
        return;
      }
      const state = await page
        .locator('form[action="/agent-connect/owner/sessions/end"]')
        .first()
        .locator("..")
        .textContent();
      observed.push(
        /stopping|closing|cleanup|ended/i.test(state) ? "stopping" : "present",
      );
      await delay(200);
    }
    throw new Error(
      "owned session cleanup did not finish within 25 seconds: " +
        (await page.locator("body").textContent()).slice(-2000),
    );
  }
  async function ownedHost(page) {
    await page.goto(ownerUrl);
    const sessions = page.locator(
      'form[action="/agent-connect/owner/sessions/end"]',
    );
    assert.equal(
      await sessions.count(),
      1,
      "the isolated capacity-one runtime has one owned host",
    );
    const id = await sessions.locator('input[name="session_id"]').inputValue();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    assert.ok(
      (await stat(join(runtime, "state/sessions", id))).isDirectory(),
      "host belongs to this run's private state",
    );
    const container = JSON.parse(
      await command("docker", [
        "inspect",
        "--format",
        '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}}}',
        `acp-sess-${id}`,
      ]),
    );
    assert.equal(
      container.labels["org.agent-connect.component"],
      "acp-session",
    );
    assert.equal(container.labels["org.agent-connect.session"], id);
    assert.equal(container.running, true, "the owned host box is live");
    ownedHostSessions.set(container.id, id);
    return container.id;
  }
  async function ownerCapture(page, state) {
    await mkdir(join(work, "screenshots"), { recursive: true });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `${state}/${width}: no horizontal overflow`,
      );
      if (width < 500)
        for (const control of await page
          .locator("button, select, input:not([type=hidden]), summary")
          .all()) {
          if (await control.isVisible())
            assert.ok(
              (await control.boundingBox()).height >= 44,
              `${state}: touch target`,
            );
        }
      await page.screenshot({
        path: join(work, "screenshots", `${state}-${width}.png`),
        fullPage: true,
      });
    }
  }
  async function effects(page) {
    return await page.locator("#book").evaluate((node) => ({
      read: Number(node.dataset.read_passageCount),
      highlight: Number(node.dataset.highlightCount),
      ask: Number(node.dataset.ask_readerCount),
    }));
  }
  const denialContext = await browser.newContext();
  const deniedPage = await appPage(denialContext);
  await requestApproval(deniedPage, "Deny");
  await deniedPage.waitForFunction(
    () => document.getElementById("error").dataset.code === "denied",
  );
  assert.ok(await deniedPage.locator("#chat-input").isDisabled());
  assert.equal((await modelRequests()).length, 0);
  await denialContext.close();
  report.checks.push(
    "gateway owner denial returns a typed application error and starts no session",
  );
  async function send(page, prompt) {
    await page.locator("#chat-input").fill(prompt);
    await page.locator("#chat-send").click();
  }
  async function settled(page, status) {
    await page.waitForFunction(
      (expected) =>
        document.querySelector(
          '#chat-messages article[data-role="assistant"]:last-child',
        )?.dataset.status === expected,
      status,
    );
    assert.equal(await page.locator("#error").textContent(), "");
  }
  const toolsPage = await connectPage();
  report.checks.push(
    "real gateway owner sign-in and fixed-tool consent pair the packed SDK without token handoff",
  );
  let refreshRequests = 0;
  toolsPage.on("request", (request) => {
    if (
      request.url() === `${publicGateway}/agent-connect/oauth/token` &&
      new URLSearchParams(request.postData() ?? "").get("grant_type") ===
        "refresh_token"
    )
      refreshRequests++;
  });
  const initialAccessToken = await toolsPage.evaluate(() => {
    const key = Object.keys(sessionStorage).find(
      (key) =>
        key.startsWith("agent-connect:acp:") && !key.endsWith(":transaction"),
    );
    const grant = JSON.parse(sessionStorage.getItem(key));
    const token = grant.token;
    grant.expiresAt = 0;
    sessionStorage.setItem(key, JSON.stringify(grant));
    return token;
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    await toolsPage.reload();
    await toolsPage.waitForFunction(
      () =>
        !document.getElementById("chat-input").disabled ||
        document.getElementById("error").textContent,
    );
    if (await toolsPage.locator("#chat-input").isEnabled()) break;
    assert.equal(
      await toolsPage.locator("#error").getAttribute("data-code"),
      "session_capacity",
    );
    assert.equal((await modelRequests()).length, 0);
    await delay(500);
  }
  assert.ok(await toolsPage.locator("#chat-input").isEnabled());
  assert.equal((await modelRequests()).length, 0);
  assert.equal(
    refreshRequests,
    1,
    "Reload refreshes the managed access token once",
  );
  const applicationToken = await toolsPage.evaluate(() => {
    const key = Object.keys(sessionStorage).find(
      (key) =>
        key.startsWith("agent-connect:acp:") && !key.endsWith(":transaction"),
    );
    return JSON.parse(sessionStorage.getItem(key)).token;
  });
  assert.notEqual(applicationToken, initialAccessToken);
  report.checks.push(
    "tab reload restores its managed grant with a real rotating refresh and no prompt replay",
  );
  const bearerOwnerPage = await fetch(`${publicGateway}/agent-connect/owner`, {
    headers: { Authorization: `Bearer ${applicationToken}` },
    redirect: "manual",
  });
  assert.ok([302, 303, 401, 403].includes(bearerOwnerPage.status));
  if ([302, 303].includes(bearerOwnerPage.status))
    assert.ok(
      bearerOwnerPage.headers
        .get("location")
        .includes("/agent-connect/owner/login"),
    );
  // Use a real pending request and a real owner CSRF value so rejection cannot
  // be satisfied merely by malformed consent fields.
  const ownerProbePar = await fetch(
    `${publicGateway}/agent-connect/oauth/par`,
    {
      method: "POST",
      headers: { Origin: origin },
      body: new URLSearchParams({
        client_id: origin,
        redirect_uri: `${origin}/`,
        resource: `${publicGateway}/acp`,
        response_type: "code",
        scope: "acp",
        state: "owner-authority-probe",
        code_challenge: "A".repeat(43),
        code_challenge_method: "S256",
        authorization_details: JSON.stringify([
          {
            type: "agent_connect",
            tools: JSON.parse(
              await readFile(join(sample, "tools.json"), "utf8"),
            ),
          },
        ]),
      }),
    },
  );
  assert.equal(ownerProbePar.status, 201);
  const ownerProbeRequest = await ownerProbePar.json();
  const ownerProbe = await toolsPage.context().newPage();
  await ownerProbe.goto(
    `${publicGateway}/agent-connect/oauth/authorize?${new URLSearchParams({ client_id: origin, request_uri: ownerProbeRequest.request_uri })}`,
  );
  await ownerProbe
    .getByRole("button", { name: "Approve", exact: true })
    .waitFor();
  const ownerCsrf = await ownerProbe
    .locator('input[name="csrf_token"]')
    .inputValue();
  const bearerConsent = await fetch(
    `${publicGateway}/agent-connect/oauth/authorize`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${applicationToken}`,
        Origin: publicGateway,
      },
      body: new URLSearchParams({
        decision: "approve",
        duration: "3600",
        request_uri: ownerProbeRequest.request_uri,
        csrf_token: ownerCsrf,
      }),
    },
  );
  assert.equal(
    bearerConsent.status,
    403,
    "An application bearer cannot approve valid owner consent",
  );
  // The rejected bearer request must not consume the owner's approval form.
  await ownerProbe.getByRole("button", { name: "Deny", exact: true }).click();
  await ownerProbe.waitForURL((url) => url.origin === origin);
  await ownerProbe.close();
  report.checks.push(
    "application bearer cannot enter owner grants or approve owner consent",
  );
  const otherOrigin = await browser.newPage();
  await otherOrigin.goto(`http://localhost:${appPort}`);
  const mismatchedClose = await otherOrigin.evaluate(
    ({ gateway, token }) =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`${gateway.replace(/^http/, "ws")}/acp`, [
          "acp.v1",
          `bearer.${token}`,
        ]);
        const timeout = setTimeout(() => {
          socket.close();
          reject(new Error("Origin mismatch was not rejected"));
        }, 5000);
        socket.onclose = (event) => {
          clearTimeout(timeout);
          resolve(event.code);
        };
        socket.onerror = () => {};
      }),
    { gateway: publicGateway, token: applicationToken },
  );
  assert.equal(
    mismatchedClose,
    4401,
    "Managed grant requires the exact approved application origin",
  );
  await otherOrigin.close();
  assert.equal((await modelRequests()).length, 0);
  report.checks.push(
    "a managed application bearer is rejected at a different browser origin",
  );
  await send(toolsPage, "SPIKE-TOOLS");
  await settled(toolsPage, "completed");
  assert.equal(await toolsPage.locator("#book mark").count(), 1);
  assert.equal(
    await toolsPage
      .locator('[data-chapter="1"]')
      .getAttribute("data-highlights"),
    "1",
  );
  assert.deepEqual(
    await toolsPage.locator("#book").evaluate((node) => ({
      read: Number(node.dataset.read_passageCount),
      highlight: Number(node.dataset.highlightCount),
    })),
    { read: 1, highlight: 1 },
  );
  assert.match(
    await toolsPage.locator("#chat-messages").textContent(),
    /DONE read=/,
  );
  report.checks.push(
    "real Codex adapter reads a passage and highlights it once",
  );
  const navigationSession = await toolsPage
    .locator("#connection-status")
    .getAttribute("data-session-id");
  const lifecycle = await toolsPage.context().newCDPSession(toolsPage);
  await lifecycle.send("Page.enable");
  report.bfcacheMisses = [];
  lifecycle.on("Page.backForwardCacheNotUsed", (event) =>
    report.bfcacheMisses.push(event.notRestoredExplanations),
  );
  await toolsPage.goto(`${origin}/?away=1`);
  await toolsPage.goBack({ waitUntil: "commit" });
  await toolsPage.waitForFunction(
    () => window.__pageRestorations.at(-1) === true,
    null,
    { timeout: 5000 },
  );
  report.bfcacheRestored = await toolsPage.evaluate(() =>
    window.__pageRestorations.at(-1),
  );
  assert.equal(
    await toolsPage.evaluate(() => window.__pageRestorations.at(-1)),
    true,
    "Browser actually restored the page from BFCache",
  );
  assert.ok(
    await toolsPage.locator("#chat-input").isEnabled(),
    "Restored chat remains usable",
  );
  assert.equal(
    await toolsPage
      .locator("#connection-status")
      .getAttribute("data-session-id"),
    navigationSession,
  );
  report.checks.push(
    "genuine browser back-forward cache restoration retains its chat and session",
  );
  const reconnectPage = toolsPage;
  await send(reconnectPage, "SPIKE-ASK");
  await reconnectPage.locator("#ask-form").waitFor({ state: "visible" });
  const beforeCachedQuestion = (await modelRequests()).length;
  await reconnectPage.goto(`${origin}/?away=1`);
  await reconnectPage.goBack({ waitUntil: "commit" });
  await reconnectPage.waitForFunction(
    () => window.__pageRestorations.at(-1) === true,
    null,
    { timeout: 5000 },
  );
  assert.ok(
    await reconnectPage.locator("#ask-form").isVisible(),
    "Pending reader question survives real BFCache restoration",
  );
  assert.equal(
    (await modelRequests()).length,
    beforeCachedQuestion,
    "Back navigation submits no model prompt or tool result",
  );
  assert.equal(
    await reconnectPage
      .locator("#book")
      .evaluate((node) => Number(node.dataset.ask_readerCount)),
    1,
  );
  report.checks.push(
    "a pending app tool survives genuine BFCache restoration without replay",
  );
  const beforeSession = await reconnectPage
    .locator("#connection-status")
    .getAttribute("data-session-id");
  assert.ok(beforeSession);
  const beforeRequests = (await modelRequests()).length;
  const beforeAccepted = (
    await fetch(`http://127.0.0.1:${controlPort}/stats`).then((response) =>
      response.json(),
    )
  ).accepted;
  await fetch(`http://127.0.0.1:${controlPort}/cut`, { method: "POST" });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (
        await fetch(`http://127.0.0.1:${controlPort}/stats`).then((response) =>
          response.json(),
        )
      ).accepted > beforeAccepted
    )
      break;
    await delay(100);
  }
  assert.ok(
    (
      await fetch(`http://127.0.0.1:${controlPort}/stats`).then((response) =>
        response.json(),
      )
    ).accepted > beforeAccepted,
    "Browser reattached after socket interruption",
  );
  await reconnectPage.locator("#ask-input").fill("Chapter one");
  await reconnectPage.locator("#ask-answer").click();
  await settled(reconnectPage, "completed");
  assert.equal(
    await reconnectPage
      .locator("#connection-status")
      .getAttribute("data-session-id"),
    beforeSession,
  );
  assert.equal(
    await reconnectPage
      .locator("#book")
      .evaluate((node) => Number(node.dataset.ask_readerCount)),
    1,
  );
  assert.equal(
    (await modelRequests()).length,
    beforeRequests + 1,
    "Reconnect submits no duplicate model prompt or tool result",
  );
  assert.match(
    await reconnectPage.locator("#chat-messages").textContent(),
    /DONE answer=/,
  );
  report.checks.push(
    "ongoing-turn reconnect retains its session and executes the held reader tool once",
  );
  const cancelPage = reconnectPage;
  await send(cancelPage, "SPIKE-ASK");
  await cancelPage.locator("#ask-form").waitFor({ state: "visible" });
  const beforeCancel = (await modelRequests()).length;
  await cancelPage.locator("#chat-stop").click();
  await settled(cancelPage, "cancelled");
  await cancelPage.locator("#ask-form").waitFor({ state: "hidden" });
  await delay(1500);
  assert.equal(
    (await modelRequests()).length,
    beforeCancel,
    "Cancelled held tool starts no follow-up model request",
  );
  assert.equal(
    await cancelPage
      .locator("#book")
      .evaluate((node) => Number(node.dataset.ask_readerCount)),
    2,
  );
  report.checks.push(
    "Stop cancels the pending reader question without a follow-up model request",
  );
  const cancelledSession = await cancelPage
    .locator("#connection-status")
    .getAttribute("data-session-id");
  await cancelPage.waitForFunction(
    () => !document.getElementById("chat-input").disabled,
  );
  assert.ok(
    await cancelPage.locator("#chat-input").isEnabled(),
    "Automatic recovery becomes available after owned box teardown",
  );
  assert.equal(
    await cancelPage
      .locator('#chat-messages article[data-status="cancelled"]')
      .count(),
    1,
    "Automatic recovery retains the cancelled transcript",
  );
  assert.equal((await modelRequests()).length, beforeCancel);
  await send(cancelPage, "SPIKE-TOOLS");
  await settled(cancelPage, "completed");
  assert.equal(
    await cancelPage
      .locator("#connection-status")
      .getAttribute("data-session-id"),
    cancelledSession,
    "The deliberate new prompt uses the recovered harness session",
  );
  assert.equal(await cancelPage.locator("#book mark").count(), 1);
  assert.equal(
    await cancelPage
      .locator("#book")
      .evaluate((node) => Number(node.dataset.ask_readerCount)),
    2,
    "The cancelled question is never replayed",
  );
  report.checks.push(
    "automatic recovery after Stop retains the transcript and accepts a deliberate new tool turn without replay",
  );
  // The approved read-only profile still permits the fixed application tools,
  // and its real native invocation fails closed. Record sandbox-startup limits
  // separately from a filesystem-policy rejection; they prove different things.
  const ownerGrants = await ownerPage(cancelPage);
  const readOnlyHost = await ownedHost(ownerGrants);
  assert.match(
    await ownerGrants.locator("body").textContent(),
    /Read-only native tools/,
  );
  await send(cancelPage, "SPIKE-SHELL-WRITE");
  await settled(cancelPage, "completed");
  const nativeWriteOutput = await cancelPage
    .locator("#chat-messages article")
    .last()
    .textContent();
  const nativeSandboxUnavailable =
    /bwrap: No permissions to create a new namespace/.test(nativeWriteOutput);
  assert.ok(
    nativeSandboxUnavailable ||
      /denied|rejected|read.only|not permitted|sandbox/i.test(
        nativeWriteOutput,
      ),
    "native write must be refused by policy or a recorded sandbox startup limitation",
  );
  assert.match(
    nativeWriteOutput,
    /Process exited with code [1-9]\d*|: failed.*(?:denied|rejected|not permitted)/is,
    "native invocation must fail rather than silently omit the effect",
  );
  report.nativeWriteProtection = {
    profile: "read-only",
    outcome: nativeSandboxUnavailable
      ? "native-sandbox-startup-unavailable"
      : "native-write-denied",
    limitation: nativeSandboxUnavailable
      ? "This Docker environment refuses native sandbox namespace creation; marker absence does not isolate read-only filesystem policy enforcement."
      : null,
  };
  const marker = await commandResult("docker", [
    "exec",
    readOnlyHost,
    "test",
    "-e",
    "/work/restricted-profile-marker",
  ]);
  assert.equal(marker.code, 1, "the real boxed native write creates no marker");
  assert.equal(
    marker.stderr,
    "",
    "marker check executed in the still-running owned box rather than a failed Docker exec",
  );
  report.nativeWriteProtection.markerAbsent = true;
  report.profileCoverage = nativeSandboxUnavailable
    ? "configured read-only; app-tools succeeds; native effect prevented by namespace refusal; filesystem restriction not independently qualified"
    : "configured read-only; app-tools succeeds; native filesystem write refused and marker absent";
  report.checks.push(
    nativeSandboxUnavailable
      ? "owner-selected Codex read-only profile permits approved app effects; native write fails closed because sandbox namespace creation is unavailable (filesystem-policy enforcement remains unqualified)"
      : "owner-selected Codex read-only profile allows approved application tool effects and denies a native filesystem write in the real box",
  );

  await send(cancelPage, "SPIKE-ASK");
  await cancelPage.locator("#ask-form").waitFor({ state: "visible" });
  const interruptedSession = await cancelPage
    .locator("#connection-status")
    .getAttribute("data-session-id");
  const beforeAbortRequests = (await modelRequests()).length;
  const beforeAbortEffects = await effects(cancelPage);
  const abortedHost = await ownedHost(ownerGrants);
  await command("docker", ["kill", "--signal", "KILL", abortedHost]);
  await cancelPage.waitForFunction(
    () =>
      !document.getElementById("chat-input").disabled &&
      document
        .getElementById("new-session-notice")
        .textContent.includes("restored"),
  );
  assert.equal(
    await cancelPage
      .locator("#connection-status")
      .getAttribute("data-session-id"),
    interruptedSession,
  );
  await cancelPage.locator("#ask-form").waitFor({ state: "hidden" });
  await delay(500);
  assert.equal(
    (await modelRequests()).length,
    beforeAbortRequests,
    "automatic recovery never repeats the uncertain prompt or tool result",
  );
  assert.deepEqual(
    await effects(cancelPage),
    beforeAbortEffects,
    "automatic recovery executes no app effect",
  );
  assert.ok(
    await cancelPage
      .locator('#chat-messages article[data-status="failed"]')
      .count(),
    "interrupted transcript remains visible",
  );
  report.checks.push(
    "the sample automatically loads the same owned session after genuine adapter exit4410, retaining transcript without replaying an uncertain prompt or effect",
  );

  await send(cancelPage, "SPIKE-ASK");
  await cancelPage.locator("#ask-form").waitFor({ state: "visible" });
  const ownerEndedHost = await ownedHost(ownerGrants);
  await ownerCapture(ownerGrants, "live-session");
  const beforeEndRequests = (await modelRequests()).length;
  const beforeEndEffects = await effects(cancelPage);
  const end = ownerGrants.getByRole("button", {
    name: "End session",
    exact: true,
  });
  await end.focus();
  assert.equal(
    await end.evaluate((control) => control === document.activeElement),
    true,
  );
  await Promise.all([
    ownerGrants.waitForNavigation({ waitUntil: "load" }),
    ownerGrants.keyboard.press("Enter"),
  ]);
  await waitNoLiveSessions(ownerGrants, ownerEndedHost);
  await cancelPage.waitForFunction(
    () =>
      document.getElementById("chat-input").disabled &&
      !document.getElementById("chat-new").disabled,
  );
  await cancelPage.locator("#ask-form").waitFor({ state: "hidden" });
  await delay(1500);
  assert.ok(
    await cancelPage.locator("#chat-input").isDisabled(),
    "owner end is terminal and never automatically resumes",
  );
  assert.equal((await modelRequests()).length, beforeEndRequests);
  assert.deepEqual(await effects(cancelPage), beforeEndEffects);
  assert.equal(
    await ownerGrants
      .getByRole("button", { name: "Revoke access", exact: true })
      .count(),
    1,
    "ending a session retains its application grant",
  );
  await ownerCapture(ownerGrants, "ended-session-active-grant");
  report.checks.push(
    "real boxed live sessions support keyboard End session, terminal4415 without automatic replay, and retain the approved app grant",
  );

  const forget = ownerGrants.getByRole("button", {
    name: "Forget this browser",
    exact: true,
  });
  await forget.focus();
  await ownerGrants.keyboard.press("Enter");
  await ownerGrants.getByLabel("Owner passphrase", { exact: true }).waitFor();
  await ownerSignIn(ownerGrants);
  assert.equal(
    await ownerGrants
      .getByRole("button", { name: "Revoke access", exact: true })
      .count(),
    1,
    "forget-browser invalidates owner verification without revoking apps",
  );
  report.checks.push(
    "real browser Forget this browser requires owner sign-in again and preserves application authority",
  );
  await cancelPage.locator("#chat-new").click();
  await cancelPage.waitForFunction(
    () => !document.getElementById("chat-input").disabled,
  );
  assert.notEqual(
    await cancelPage
      .locator("#connection-status")
      .getAttribute("data-session-id"),
    interruptedSession,
    "deliberate connection after owner end creates a new native conversation",
  );
  const beforeRevoke = (await modelRequests()).length;
  const beforeRevokeEffects = await cancelPage
    .locator("#book")
    .evaluate((node) => ({
      read: Number(node.dataset.read_passageCount),
      highlight: Number(node.dataset.highlightCount),
      ask: Number(node.dataset.ask_readerCount),
    }));
  await ownerGrants.goto(ownerUrl);
  await ownerGrants
    .getByRole("button", { name: "Revoke access", exact: true })
    .waitFor();
  const listedGrants = await ownerGrants.locator("body").textContent();
  assert.ok(listedGrants.includes(origin));
  assert.ok(listedGrants.includes("Active"));
  assert.ok(listedGrants.includes("Expires"));
  const revokedHost = await ownedHost(ownerGrants);
  await ownerGrants
    .getByRole("button", { name: "Revoke access", exact: true })
    .click();
  await cancelPage.waitForFunction(
    () =>
      document.getElementById("error").dataset.code === "invalid_app_grant" &&
      document.getElementById("chat-input").disabled &&
      !document.getElementById("connect").disabled,
  );
  assert.equal(
    await cancelPage.evaluate(
      () =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("agent-connect:acp:"),
        ).length,
    ),
    0,
  );
  assert.ok(await cancelPage.locator("#chat-new").isDisabled());
  await delay(500);
  assert.equal(
    (await modelRequests()).length,
    beforeRevoke,
    "Revocation sends no prompt and does not replay previous effects",
  );
  assert.deepEqual(
    await cancelPage.locator("#book").evaluate((node) => ({
      read: Number(node.dataset.read_passageCount),
      highlight: Number(node.dataset.highlightCount),
      ask: Number(node.dataset.ask_readerCount),
    })),
    beforeRevokeEffects,
    "Revocation executes no application tool effect",
  );
  report.checks.push(
    "gateway owner grants list revokes the actual application grant, clears tab authorization and forbids automatic replay",
  );
  // Revocation ends authority immediately; boxed cleanup retains capacity until
  // its owned container/network are gone. Do not replace that gate with a delay.
  await waitNoLiveSessions(ownerGrants, revokedHost);
  await ownerGrants.close();
  await cancelPage.close();
  const firstGrantPage = await connectPage();
  const allGrantsOwner = await ownerPage(firstGrantPage);
  const firstGrantHost = await ownedHost(allGrantsOwner);
  await allGrantsOwner
    .getByRole("button", { name: "End session", exact: true })
    .click();
  await waitNoLiveSessions(allGrantsOwner, firstGrantHost);
  await firstGrantPage.waitForFunction(
    () =>
      document.getElementById("chat-input").disabled &&
      !document.getElementById("chat-new").disabled,
  );
  const secondGrantPage = await connectPage();
  await allGrantsOwner.goto(ownerUrl);
  assert.equal(
    await allGrantsOwner
      .getByRole("button", { name: "Revoke access", exact: true })
      .count(),
    2,
  );
  await ownerCapture(allGrantsOwner, "two-active-grants");
  const beforeAllRequests = (await modelRequests()).length;
  const revokeAll = allGrantsOwner.getByRole("button", {
    name: "Revoke all active grants",
    exact: true,
  });
  await revokeAll.focus();
  assert.equal(
    await revokeAll.evaluate((control) => control === document.activeElement),
    true,
  );
  await allGrantsOwner.keyboard.press("Enter");
  await allGrantsOwner.waitForFunction(
    () =>
      document.querySelector(
        'form[action="/agent-connect/owner/grants/revoke-all"] button',
      )?.disabled === true,
  );
  assert.ok(
    await allGrantsOwner
      .getByRole("button", { name: "Revoke all active grants", exact: true })
      .isDisabled(),
  );
  assert.equal(
    await allGrantsOwner
      .getByRole("button", { name: "Revoke access", exact: true })
      .count(),
    0,
  );
  await secondGrantPage.waitForFunction(
    () => document.getElementById("error").dataset.code === "invalid_app_grant",
  );
  // The ended tab has no live channel. Its next deliberate connection must
  // discover revoked authority, clear authorization, and submit no prompt.
  await firstGrantPage.locator("#chat-new").click();
  await firstGrantPage.waitForFunction(
    () => document.getElementById("error").dataset.code === "invalid_app_grant",
  );
  for (const page of [firstGrantPage, secondGrantPage]) {
    assert.ok(await page.locator("#chat-input").isDisabled());
    assert.equal(
      await page.evaluate(
        () =>
          Object.keys(sessionStorage).filter((key) =>
            key.startsWith("agent-connect:acp:"),
          ).length,
      ),
      0,
    );
  }
  await delay(500);
  assert.equal(
    (await modelRequests()).length,
    beforeAllRequests,
    "revoke-all triggers no model turn or uncertain effect replay",
  );
  await ownerCapture(allGrantsOwner, "all-grants-revoked");
  report.checks.push(
    "real browser keyboard revoke-all invalidates two application grants, clears active and deliberately reconnected tabs, and leaves owner verification active",
  );

  await command(gateway, ["egress", "stop", "--name", egressName]);
  const outageDeadline = Date.now() + 25000;
  while (Date.now() < outageDeadline) {
    await allGrantsOwner.reload();
    if (await allGrantsOwner.locator(".runtime-problem[role=status]").count())
      break;
    await delay(500);
  }
  const banner = allGrantsOwner.locator(".runtime-problem[role=status]");
  assert.match(
    await banner.textContent(),
    /boxed runtime.*unavailable|health check.*stalled/i,
  );
  assert.match(await banner.textContent(), /agent-connect doctor/);
  const outageDoctor = await commandResult(gateway, [
    "doctor",
    "--config",
    join(runtime, "config.json"),
    "--json",
  ]);
  const outageDiagnosis = jsonResult(outageDoctor, "outage doctor");
  assert.equal(outageDoctor.code, 1);
  assert.equal(outageDiagnosis.ok, false);
  assert.ok(
    outageDiagnosis.checks.some(
      (check) =>
        check.status === "fail" &&
        typeof check.fix === "string" &&
        check.fix.length > 0,
    ),
  );
  assert.equal(
    JSON.stringify(outageDiagnosis).includes(ownerPassphrase),
    false,
  );
  await ownerCapture(allGrantsOwner, "runtime-problem");
  report.checks.push(
    "a real owned egress outage produces responsive owner runtime repair guidance and failing artifact-installed doctor JSON",
  );
  report.parityCoverage = [
    "setup-plan",
    "setup-apply",
    "doctor-json",
    "service-offline",
    "profile-readonly",
    "sample-auto-recovery",
    "sessions-end",
    "forget-browser",
    "revoke-all",
    "runtime-problem",
  ];
  await allGrantsOwner.close();
  await firstGrantPage.close();
  await secondGrantPage.close();
  assert.deepEqual(report.pageErrors ?? [], []);
  report.status = "passed";
  console.log(report.checks.map((check) => `PASS ${check}`).join("\n"));
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  for (const child of services) if (child.tail()) console.error(child.tail());
  for (const name of resources.containers)
    console.error(
      (await command("docker", ["logs", name]).catch(String)).slice(-3000),
    );
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await Promise.all([...services].map(stop));
  let cleanupFailure;
  try {
    report.cleanup = await cleanSessionResources();
  } catch (error) {
    cleanupFailure = error;
    report.status = "failed";
    report.cleanupError = error.message;
  }
  for (const name of resources.containers)
    await command("docker", ["rm", "-f", name]).catch(() => {});
  for (const network of resources.networks)
    await command("docker", ["network", "rm", network]).catch(() => {});
  await writeFile(join(work, "report.json"), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  if (cleanupFailure) throw cleanupFailure;
}
