#!/usr/bin/env node
// Unreleased ACP gateway launcher. No downloads or credential access at runtime.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import process from "node:process";
const require = createRequire(import.meta.url);
const platform = `${process.platform}-${process.arch}`;
const supported = new Set(["darwin-arm64", "linux-x64", "linux-arm64"]);
if (!supported.has(platform))
  throw new Error(
    `Unsupported gateway platform ${platform}; Windows is pending.`,
  );
let binary = process.env.AGENT_CONNECT_GATEWAY_BIN;
if (!binary) {
  try {
    binary = require.resolve(
      `@open-agent-connect/gateway-${platform}/bin/agent-connect-gateway`,
    );
  } catch {
    throw new Error(
      `Gateway binary for ${platform} is unavailable. This package is an unpublished dry run; install the matching platform artifact.`,
    );
  }
}
if (!existsSync(binary)) throw new Error("Gateway executable does not exist.");
const adapters = [
  "@agentclientprotocol/codex-acp",
  "@agentclientprotocol/claude-agent-acp",
].map((name) => dirname(require.resolve(`${name}/package.json`)));
const child = spawn(binary, process.argv.slice(2), {
  stdio: "inherit",
  env: {
    ...process.env,
    AGENT_CONNECT_ADAPTER_PATH: adapters
      .map((path) => join(path, "..", "..", ".bin"))
      .join(":"),
  },
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
