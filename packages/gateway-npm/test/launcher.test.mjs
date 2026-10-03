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

test("published launcher accepts later Node majors while provider compatibility stays pinned", async () => {
  const { readFile } = await import("node:fs/promises");
  const { satisfies } = await import("semver");
  const manifest = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"),
  );
  const plugin = JSON.parse(
    await readFile(
      resolve(import.meta.dirname, "../../openclaw-plugin/package.json"),
      "utf8",
    ),
  );
  assert.equal(satisfies("24.14.0", manifest.engines.node), false);
  assert.equal(satisfies("24.15.0", manifest.engines.node), true);
  assert.equal(satisfies("26.0.0", manifest.engines.node), true);
  assert.equal(satisfies("26.0.0", plugin.engines.node), false);
});
