#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const runRoot = "/run/agent-connect";
const dataRoot = "/var/lib/agent-connect";
const omnigentUrl = "http://127.0.0.1:6767";
const children = [];
let stopping = false;

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => void shutdown(signal, 0));
}

for (const directory of [
  runRoot,
  `${dataRoot}/omnigent`,
  `${dataRoot}/omnigent/artifacts`,
  "/workspace",
  "/home/agentconnect/.cache",
  "/home/agentconnect/.config",
  "/home/agentconnect/.local/share",
]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

const configPath = `${runRoot}/config.yaml`;
writeFileSync(
  configPath,
  `telemetry: false

acp:
  agents:
    - name: Codex ACP
      command: "node /app/scripts/deterministic-acp-agent.mjs"
      session_id_mode: server
`,
  { mode: 0o600 },
);

const serviceEnv = {
  ...process.env,
  HOME: "/home/agentconnect",
  TMPDIR: "/tmp",
  XDG_CACHE_HOME: "/home/agentconnect/.cache",
  XDG_CONFIG_HOME: "/home/agentconnect/.config",
  XDG_DATA_HOME: "/home/agentconnect/.local/share",
  OMNIGENT_CONFIG_HOME: runRoot,
  OMNIGENT_DATA_DIR: `${dataRoot}/omnigent`,
  OMNIGENT_RUNNER_ENV_PASSTHROUGH:
    "AGENT_CONNECT_ACP_TRANSCRIPT,AGENT_CONNECT_DETERMINISTIC_SCENARIOS,AGENT_CONNECT_DETERMINISTIC_TOOL_ARGUMENTS,AGENT_CONNECT_DETERMINISTIC_TOOL_NAME,HOME,PATH,TMPDIR,XDG_CACHE_HOME,XDG_CONFIG_HOME,XDG_DATA_HOME",
  NO_BROWSER: "1",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};

const omnigent = "/opt/omnigent/bin/omnigent";
const server = start("omnigent-server", omnigent, [
  "server",
  "--host",
  "127.0.0.1",
  "--port",
  "6767",
  "--database-uri",
  `sqlite:///${dataRoot}/omnigent/chat.db`,
  "--artifact-location",
  `${dataRoot}/omnigent/artifacts`,
  "--config",
  configPath,
  "--no-open",
]);
await waitFor(
  "Omnigent server",
  async () => {
    const response = await fetch(`${omnigentUrl}/v1/hosts`).catch(
      () => undefined,
    );
    return response?.ok === true;
  },
  server,
);

const host = start("omnigent-host", omnigent, [
  "host",
  "--server",
  omnigentUrl,
  "--non-interactive",
]);
await waitFor(
  "Omnigent host",
  async () => {
    const response = await fetch(`${omnigentUrl}/v1/hosts`).catch(
      () => undefined,
    );
    if (!response?.ok) return false;
    const body = await response.json();
    return (
      body.hosts?.some((candidate) => candidate.status === "online") === true
    );
  },
  host,
);

const gateway = start("gateway", "node", [
  "/app/packages/gateway/dist/main.js",
]);
await waitFor(
  "Agent Connect gateway",
  async () => {
    const response = await fetch("http://127.0.0.1:8787/healthz").catch(
      () => undefined,
    );
    return response?.ok === true;
  },
  gateway,
);
process.stdout.write("Agent Connect judge demo is ready\n");

await new Promise(() => {});

function start(name, command, args) {
  const child = spawn(command, args, {
    env: serviceEnv,
    detached: true,
    stdio: "inherit",
  });
  const service = { name, process: child };
  children.push(service);
  child.once("exit", (code, signal) => {
    if (!stopping) {
      process.stderr.write(
        `${name} exited unexpectedly (code=${code}, signal=${signal})\n`,
      );
      void shutdown("SIGTERM", 1);
    }
  });
  return service;
}

async function waitFor(name, probe, service) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (service.process.exitCode !== null) {
      throw new Error(`${name} exited before becoming ready`);
    }
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${name} did not become ready in time`);
}

async function shutdown(signal, exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of [...children].reverse()) {
    if (child.process.exitCode !== null || !child.process.pid) continue;
    try {
      process.kill(-child.process.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await Promise.race([
    Promise.all(
      children.map(
        ({ process: child }) =>
          new Promise((resolve) => {
            if (child.exitCode !== null) resolve(undefined);
            else child.once("exit", resolve);
          }),
      ),
    ),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  process.exit(exitCode);
}
