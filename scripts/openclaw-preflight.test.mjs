import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isSupportedOpenClawNode,
  openClawFixtureEnvironment,
} from "./openclaw-test-runtime.mjs";

test("supported operator/test profile is Node 24 LTS >=24.15, not every newer major", () => {
  for (const version of [
    "22.22.3",
    "23.11.0",
    "24.14.9",
    "25.0.0",
    "25.9.0",
    "26.0.0",
  ]) {
    assert.equal(isSupportedOpenClawNode(version), false, version);
  }
  for (const version of ["24.15.0", "24.15.1", "24.16.0"]) {
    assert.equal(isSupportedOpenClawNode(version), true, version);
  }
});

test("OpenClaw child OS home and XDG paths belong only to its fixture", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "agent-connect-openclaw-env-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = await openClawFixtureEnvironment(directory, {
    path: "/example/tools/bin",
  });
  for (const [key, suffix] of [
    ["HOME", "home"],
    ["XDG_STATE_HOME", "xdg-state"],
    ["XDG_CONFIG_HOME", "xdg-config"],
    ["OPENCLAW_STATE_DIR", "state"],
  ]) {
    assert.equal(env[key], join(directory, suffix));
    const metadata = await stat(env[key]);
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.mode & 0o077, 0);
  }
  assert.equal(env.PATH, "/example/tools/bin");
  assert.equal(
    Object.keys(env).some((key) => key.endsWith("API_KEY")),
    false,
  );
  // Exercise the OS-home resolver only; no credential files are opened.
  const resolvedHome = execFileSync(
    process.execPath,
    ["-e", "process.stdout.write(require('node:os').homedir())"],
    { env, encoding: "utf8" },
  );
  assert.equal(resolvedHome, env.HOME);
});
