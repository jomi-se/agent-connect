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
async function command(bin, args, options = {}) {
  const child = spawn(bin, args, {
    cwd: work,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  let tail = "";
  child.stdout.on("data", (bytes) => {
    tail = (tail + bytes).slice(-8000);
  });
  child.stderr.on("data", (bytes) => {
    tail = (tail + bytes).slice(-8000);
  });
  return await new Promise((ok, fail) => {
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0
        ? ok(tail)
        : fail(new Error(`${bin} ${args[0]} failed (${code})\n${tail}`)),
    );
  });
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
async function modelRequests() {
  const content = await readFile(join(work, "logs/model.jsonl"), "utf8").catch(
    () => "",
  );
  return content
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((entry) => entry.path === "/v1/responses");
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
    assert.equal(packed.metadata.version, release.version);
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
  const gateway = join(install, "node_modules/.bin/agent-connect-gateway");
  assert.equal(
    (await command(gateway, ["--version"])).trim(),
    `agent-connect-gateway ${release.version}`,
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
    (await readFile(join(sample, "main.js"), "utf8")).includes(
      'from "@open-agent-connect/web/acp"',
    ),
  );
  manifest.dependencies["@open-agent-connect/web"] = `file:${sdkPackage.file}`;
  await writeFile(join(sample, "package.json"), JSON.stringify(manifest));
  await command(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: sample },
  );
  // Resolve the installed public subpath; no SDK source or aliases enter this build.
  const resolved = await command(
    "node",
    [
      "--input-type=module",
      "-e",
      'console.log(import.meta.resolve("@open-agent-connect/web/acp"))',
    ],
    { cwd: sample },
  );
  assert.ok(
    resolved.includes("/node_modules/@open-agent-connect/web/dist/acp.js"),
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
  const preview = service(
    "npm",
    ["run", "preview", "--", "--port", String(appPort)],
    { cwd: sample },
  );
  await ready(origin, preview);
  await command(gateway, [
    "init",
    "--directory",
    runtime,
    "--harness",
    "codex",
    "--allow-origin",
    origin,
    "--tools",
    join(sample, "tools.json"),
    "--listen",
    `127.0.0.1:${gatewayPort}`,
    "--session-image",
    sessionImage,
    "--egress-container",
    egressName,
  ]);
  for (const file of ["config.json", "grant.json", "tools.json"])
    assert.equal((await stat(join(runtime, file))).mode & 0o077, 0);
  assert.equal((await stat(join(runtime, "home"))).mode & 0o077, 0);
  const grant = JSON.parse(await readFile(join(runtime, "grant.json"), "utf8"));
  assert.equal(grant.gatewayUrl, `ws://127.0.0.1:${gatewayPort}/acp`);
  assert.ok(grant.token.length >= 32);
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
  resources.containers.push(egressName);
  await recordResources();
  await command(gateway, [
    "egress",
    "start",
    "--name",
    egressName,
    "--session-image",
    sessionImage,
  ]);
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
    ],
    { env: { ...process.env, AGENT_CONNECT_TEST_ROOT: work } },
  );
  await ready(`http://127.0.0.1:${gatewayPort}`, gatewayService);
  const relay = service("node", ["/opt/acceptance/relay.mjs"], {
    env: {
      ...process.env,
      RELAY_TARGET: String(gatewayPort),
      RELAY_LISTEN: String(relayPort),
      RELAY_CONTROL: String(controlPort),
    },
  });
  await ready(`http://127.0.0.1:${controlPort}/stats`, relay);
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  async function connectPage(throughRelay = false) {
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.on("pageerror", (error) => {
      report.pageErrors ??= [];
      report.pageErrors.push(error.message);
    });
    await page.goto(origin);
    // Exercise the user-facing grant upload and consent flow, not hidden globals.
    const uploaded = {
      ...grant,
      gatewayUrl: `ws://127.0.0.1:${throughRelay ? relayPort : gatewayPort}/acp`,
    };
    await page.locator("#grant-file").setInputFiles({
      name: "grant.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(uploaded)),
    });
    await page.waitForFunction(
      (expected) => document.getElementById("gateway-url").value === expected,
      uploaded.gatewayUrl,
    );
    await page.locator("#approve-tools").check();
    await page.locator("#connect").click();
    await page.waitForFunction(
      () => !document.getElementById("chat-input").disabled,
    );
    return page;
  }
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
  await toolsPage.close();
  const reconnectPage = await connectPage(true);
  await send(reconnectPage, "SPIKE-ASK");
  await reconnectPage.locator("#ask-form").waitFor({ state: "visible" });
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
  await reconnectPage.close();
  const cancelPage = await connectPage();
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
    1,
  );
  report.checks.push(
    "Stop cancels the pending reader question without a follow-up model request",
  );
  await cancelPage.close();
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
