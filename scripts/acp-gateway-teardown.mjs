// Real boxed gateway teardown, without credentials or live model calls.
// Check gateway-owned resources before the driver's bounded fallback cleanup.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "..");
const root = await mkdtemp(join(tmpdir(), "agent-connect-teardown-"));
const suffix = root.split("-").at(-1).toLowerCase();
const image =
  process.env.ACP_SESSION_IMAGE ??
  `agent-connect-session:${JSON.parse(await readFile(join(repo, "deploy/acp-gateway/session/package.json"), "utf8")).version}`;
const sourceBinary =
  process.env.ACP_GATEWAY_BIN ??
  join(repo, "target/debug/agent-connect-gateway");
const binary = join(root, "gateway");
const egressName = `acp-test-egress-${suffix}`;
const modelName = `acp-test-model-${suffix}`;
const baseName = `acp-test-base-${suffix}`;
const origin = "http://teardown.example";
const token = "deterministic-teardown-fixture";
const componentLabel = "org.agent-connect.component";
const sessionLabel = "org.agent-connect.session";
const realDocker = (
  await exec("sh", ["-c", "command -v docker"])
).stdout.trim();
const children = new Set();
const sockets = new Set();
const sessionDirs = [];
const sharedContainers = [];
const sharedNetworks = [];
const reports = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function command(bin, args, options = {}) {
  return (
    await exec(bin, args, {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      ...options,
    })
  ).stdout.trim();
}
const docker = (args) => command(realDocker, args);
function immutableId(output) {
  assert.match(output, /^[a-f0-9]{64}$/i, "expected immutable Docker ID");
  return output;
}
async function inspect(kind, name) {
  try {
    return JSON.parse(await docker(["inspect", "--type", kind, name]))[0];
  } catch (error) {
    // A missing resource proves cleanup; a daemon failure does not.
    if (
      /No such (container|network):|network .* not found/.test(
        error.stderr ?? "",
      )
    )
      return null;
    throw error;
  }
}
async function waitFor(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out: ${label}; diagnostics ${root}`);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      "gateway exit",
      30000,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}
async function sessions(dir) {
  const path = join(dir, "state/sessions");
  return await readdir(path).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}
async function sessionResources(dir) {
  const resources = [];
  for (const session of await sessions(dir)) {
    assert.match(session, /^[a-f0-9-]{36}$/i);
    for (const [kind, name] of [
      ["container", `acp-sess-${session}`],
      ["network", `acp-sess-net-${session}`],
    ]) {
      const resource = await inspect(kind, name);
      resources.push({ session, kind, name, resource });
    }
  }
  return resources;
}
function assertOwned({ session, kind, resource }) {
  const labels = kind === "network" ? resource.Labels : resource.Config.Labels;
  assert.equal(
    labels?.[componentLabel],
    "acp-session",
    "refusing cleanup of an unowned resource",
  );
  assert.equal(
    labels?.[sessionLabel],
    session,
    "refusing cleanup of a replaced session name",
  );
  return immutableId(resource.Id);
}

await copyFile(sourceBinary, binary);
await chmod(binary, 0o755);
await mkdir(join(root, "bin"));
await mkdir(join(root, "logs"), { mode: 0o700 });
await writeFile(
  join(root, "bin/docker"),
  `#!/bin/sh
if { [ "$1" = create ] && [ "$ACP_TEARDOWN_FAULT" = reject ]; }; then
  echo "Injected container-create rejection" >&2
  exit 1
fi
if { [ "$1" = create ] && [ "$ACP_TEARDOWN_FAULT" = lost-box ]; } || { [ "$1" = network ] && [ "$2" = create ] && [ "$ACP_TEARDOWN_FAULT" = lost-network ]; }; then
  "$ACP_REAL_DOCKER" "$@" >/dev/null
  status=$?
  if [ "$status" = 0 ]; then echo "Injected lost create response" >&2; exit 1; fi
  exit "$status"
fi
if [ "$1" = create ] && [ "$ACP_TEARDOWN_FAULT" = delay ]; then
  "$ACP_REAL_DOCKER" "$@"
  status=$?
  touch "$ACP_TEARDOWN_MARKER"
  sleep 3
  exit "$status"
fi
exec "$ACP_REAL_DOCKER" "$@"
`,
);
await chmod(join(root, "bin/docker"), 0o755);

async function runCase(mode) {
  const active = mode.endsWith("active") || mode === "cancel-then-bye";
  const startupFailure =
    mode.startsWith("startup-") && mode !== "startup-shutdown";
  const preflightFailure = [
    "startup-peer-failure",
    "startup-unowned-egress",
    "startup-stopped-egress",
  ].includes(mode);
  if (mode === "startup-stopped-egress")
    await docker(["stop", sharedContainers[0]]);
  const dir = join(root, mode);
  sessionDirs.push(dir); // Register before any allocation/readiness failure.
  await mkdir(join(dir, "home"), { recursive: true, mode: 0o700 });
  const port = await freePort();
  const fault =
    {
      "startup-box-failure": "reject",
      "startup-lost-box-response": "lost-box",
      "startup-lost-network-response": "lost-network",
      "startup-shutdown": "delay",
    }[mode] ?? "";
  let log = "";
  const child = spawn(
    binary,
    [
      "serve",
      "--boxed",
      "--harness",
      "codex",
      "--harness-home",
      join(dir, "home"),
      "--mock-root",
      dir,
      "--mock-container",
      modelName,
      "--egress-container",
      mode === "startup-peer-failure"
        ? `acp-test-absent-${suffix}`
        : mode === "startup-unowned-egress"
          ? modelName
          : egressName,
      "--session-image",
      image,
      "--tools",
      join(repo, "examples/acp-chat/tools.json"),
      "--state-dir",
      join(dir, "state"),
      "--listen",
      `127.0.0.1:${port}`,
      "--allow-origin",
      origin,
      "--headless-static-bearer",
      "--token",
      token,
      "--resume-grace-secs",
      "1",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        HOME: dir,
        LANG: "C.UTF-8",
        ACP_REAL_DOCKER: realDocker,
        ACP_TEARDOWN_FAULT: fault,
        ACP_TEARDOWN_MARKER: join(dir, "created"),
      },
    },
  );
  children.add(child);
  child.stderr.on("data", (data) => {
    log += data;
  });
  child.on("error", (error) => {
    log += String(error);
  });
  let socket;
  try {
    if (preflightFailure) {
      await waitFor(
        () => child.exitCode !== null,
        `${mode} preflight rejection`,
      );
      assert.notEqual(child.exitCode, 0);
      assert.ok(
        !log.includes("listening"),
        "unsafe egress is rejected before listening",
      );
      assert.match(log, /egress/i);
      assert.equal(
        (await sessions(dir)).length,
        0,
        "preflight allocates no session resources",
      );
      if (mode === "startup-stopped-egress") {
        await command(binary, [
          "egress",
          "start",
          "--name",
          egressName,
          "--session-image",
          image,
        ]);
      }
      for (const id of sharedContainers)
        assert.equal((await inspect("container", id))?.State.Running, true);
      reports.push({
        mode,
        rejectedBeforeListening: true,
        gatewayOnlyCleanup: true,
        sharedPeersRunning: true,
      });
      console.log(`OK gateway teardown ${mode}`);
      return;
    }
    await waitFor(() => log.includes("listening"), `${mode} listening`);
    socket = new WebSocket(
      `ws://127.0.0.1:${port}/acp`,
      ["agent-connect.resume.v1", `bearer.${token}`],
      { origin },
    );
    sockets.add(socket);
    let initialized = false,
      streaming = false,
      closed = false,
      sessionId,
      terminal,
      sequence = 0;
    const send = (message) =>
      socket.send(JSON.stringify({ t: "m", s: ++sequence, m: message }));
    socket.on("error", () => {});
    socket.on("close", () => {
      closed = true;
    });
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.t === "attached")
        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: 1, clientCapabilities: {} },
        });
      if (frame.t !== "m") return;
      socket.send(JSON.stringify({ t: "a", s: frame.s }));
      const message = frame.m;
      if (message.id === 1 && !message.error) {
        initialized = true;
        if (active)
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: { cwd: ".", mcpServers: [] },
          });
      }
      if (message.id === 2) {
        sessionId = message.result?.sessionId;
        if (sessionId)
          send({
            jsonrpc: "2.0",
            id: 3,
            method: "session/prompt",
            params: {
              sessionId,
              prompt: [{ type: "text", text: "SPIKE-SLOW" }],
            },
          });
      }
      if (
        message.method === "session/update" &&
        message.params.update.sessionUpdate === "agent_message_chunk"
      )
        streaming = true;
      if (message.id === 3) terminal = message.result ?? message.error;
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ t: "attach" }));
    if (mode === "startup-shutdown") {
      await waitFor(
        () =>
          access(join(dir, "created")).then(
            () => true,
            () => false,
          ),
        "box allocated before startup shutdown",
      );
      child.kill("SIGTERM");
    } else {
      await waitFor(
        () => (startupFailure ? closed : active ? streaming : initialized),
        `${mode} ready`,
      );
      assert.equal(
        (await sessions(dir)).length,
        1,
        "one session was allocated",
      );
      if (mode === "cancel-then-bye") {
        send({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId },
        });
        await waitFor(() => terminal, "cancel terminal");
        assert.equal(terminal.stopReason, "cancelled");
        const retained = await sessionResources(dir);
        assert.ok(
          retained.every(({ resource }) => resource),
          "cancel keeps the reusable box/network",
        );
        assert.ok(
          retained.find(({ kind }) => kind === "container").resource.State
            .Running,
        );
        socket.send(JSON.stringify({ t: "bye" }));
      } else if (mode.startsWith("bye"))
        socket.send(JSON.stringify({ t: "bye" }));
      else if (mode.startsWith("expiry")) socket.terminate();
      else if (mode.startsWith("shutdown")) child.kill("SIGTERM");
    }
    await waitFor(
      async () =>
        (await sessionResources(dir)).every(
          ({ resource }) => resource === null,
        ),
      `${mode} gateway-only cleanup`,
      30000,
    );
    assert.equal(
      (await sessions(dir)).length,
      1,
      "startup allocated exactly one session",
    );
    if (mode.startsWith("shutdown") || mode === "startup-shutdown") {
      await waitFor(
        () => child.exitCode !== null,
        `${mode} clean gateway exit`,
      );
      assert.equal(child.exitCode, 0);
    }
    for (const id of sharedContainers)
      assert.equal(
        (await inspect("container", id))?.State.Running,
        true,
        "shared fixture peers survive session teardown",
      );
    reports.push({ mode, gatewayOnlyCleanup: true, sharedPeersRunning: true });
    console.log(`OK gateway teardown ${mode}`);
  } finally {
    socket?.terminate();
    await stop(child);
    if (mode === "startup-stopped-egress") {
      await command(binary, [
        "egress",
        "start",
        "--name",
        egressName,
        "--session-image",
        image,
      ]);
    }
    await writeFile(join(dir, "gateway.log"), log);
  }
}

let failure;
try {
  await command(binary, [
    "egress",
    "start",
    "--name",
    egressName,
    "--session-image",
    image,
  ]);
  const egress = await inspect("container", egressName);
  assert.equal(egress.Config.Labels[componentLabel], "acp-egress");
  sharedContainers.push(immutableId(egress.Id));
  await command(binary, [
    "egress",
    "start",
    "--name",
    egressName,
    "--session-image",
    image,
  ]);
  assert.equal(
    (await inspect("container", egressName)).Id,
    egress.Id,
    "running owned proxy is reused",
  );
  await docker(["stop", egress.Id]);
  await command(binary, [
    "egress",
    "start",
    "--name",
    egressName,
    "--session-image",
    image,
  ]);
  assert.equal(
    (await inspect("container", egressName)).Id,
    egress.Id,
    "stopped owned proxy is restarted by ID",
  );
  assert.equal(
    (await inspect("container", egressName)).HostConfig.RestartPolicy.Name,
    "unless-stopped",
  );
  assert.equal(
    (await inspect("container", egressName)).HostConfig.LogConfig.Config[
      "max-size"
    ],
    "10m",
  );
  sharedNetworks.push(
    immutableId(await docker(["network", "create", "--internal", baseName])),
  );
  sharedContainers.push(
    immutableId(
      await docker([
        "run",
        "--detach",
        "--name",
        modelName,
        "--network",
        sharedNetworks[0],
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "--entrypoint",
        "node",
        "--mount",
        `type=bind,src=${join(repo, "deploy/acp-gateway/test/fixtures/mock-model/server.mjs")},dst=/fixture.mjs,readonly`,
        "--mount",
        `type=bind,src=${join(root, "logs")},dst=/log`,
        "-e",
        "MOCK_HOST=0.0.0.0",
        "-e",
        "MOCK_PORT=18931",
        "-e",
        "MOCK_LOG=/log/model.jsonl",
        image,
        "/fixture.mjs",
      ]),
    ),
  );
  for (const mode of [
    "bye-idle",
    "expiry-idle",
    "shutdown-idle",
    "bye-active",
    "expiry-active",
    "shutdown-active",
    "cancel-then-bye",
    "startup-peer-failure",
    "startup-unowned-egress",
    "startup-stopped-egress",
    "startup-box-failure",
    "startup-lost-box-response",
    "startup-lost-network-response",
    "startup-shutdown",
  ])
    await runCase(mode);
} catch (error) {
  failure = error;
} finally {
  // This cleanup happens only after assertions: it cannot supply passing evidence.
  for (const socket of sockets) socket.terminate();
  for (const child of children)
    await stop(child).catch((error) => {
      failure ??= error;
    });
  for (const dir of sessionDirs) {
    const resources = await sessionResources(dir).catch((error) => {
      failure ??= error;
      return [];
    });
    const owned = [];
    for (const resource of resources.filter(({ resource }) => resource)) {
      try {
        owned.push({ ...resource, id: assertOwned(resource) });
      } catch (error) {
        failure ??= error;
      }
    }
    for (const resource of owned.filter(({ kind }) => kind === "container"))
      await docker(["rm", "--force", resource.id]).catch((error) => {
        failure ??= error;
      });
    for (const resource of owned.filter(({ kind }) => kind === "network")) {
      for (const peer of sharedContainers)
        await docker([
          "network",
          "disconnect",
          "--force",
          resource.id,
          peer,
        ]).catch(() => {});
      await docker(["network", "rm", resource.id]).catch((error) => {
        failure ??= error;
      });
    }
  }
  for (const id of sharedContainers.reverse())
    await docker(["rm", "--force", id]).catch((error) => {
      failure ??= error;
    });
  for (const id of sharedNetworks)
    await docker(["network", "rm", id]).catch((error) => {
      failure ??= error;
    });
  await writeFile(
    join(root, "report.json"),
    JSON.stringify({ reports, failure: failure?.stack ?? null }, null, 2),
  );
  console.log(`Teardown diagnostics: ${root}`);
}
if (failure) throw failure;
