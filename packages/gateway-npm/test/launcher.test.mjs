import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const launcher = resolve(import.meta.dirname, "../bin/gateway.mjs");
test("launcher forwards arguments and exit status to a selected local executable", () => {
  const result = spawnSync(process.execPath, [launcher, "--version"], {
    encoding: "utf8",
    env: { ...process.env, AGENT_CONNECT_GATEWAY_BIN: process.execPath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.version);
});
test("missing local binary fails without downloading anything", () => {
  const result = spawnSync(process.execPath, [launcher, "--version"], {
    encoding: "utf8",
    env: { ...process.env, AGENT_CONNECT_GATEWAY_BIN: "/nonexistent/gateway" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not exist/);
});
