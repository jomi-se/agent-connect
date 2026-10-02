#!/usr/bin/env node
// Unreleased ACP gateway launcher. No downloads or credential access at runtime.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import process from "node:process";
const require = createRequire(import.meta.url);
const platform = `${process.platform}-${process.arch}`;
const supported = new Set(["darwin-arm64", "linux-x64", "linux-arm64"]);
function fail(message, code = 1) {
  console.error(`agent-connect-gateway: ${message}`);
  process.exit(code);
}
if (!supported.has(platform))
  fail(
    `Unsupported platform ${platform}. Supported: Apple Silicon, Linux x64/ARM64. Windows is not yet supported.`,
    2,
  );
let binary = process.env.AGENT_CONNECT_GATEWAY_BIN;
if (!binary) {
  try {
    binary = require.resolve(
      `@open-agent-connect/gateway-${platform}/bin/agent-connect-gateway`,
    );
  } catch {
    fail(
      `Binary for ${platform} is unavailable. Reinstall with optional dependencies enabled, or install the matching release platform tarball.`,
    );
  }
}
if (!existsSync(binary)) fail("Gateway executable does not exist.");
const child = spawn(binary, process.argv.slice(2), {
  stdio: "inherit",
  env: process.env,
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
