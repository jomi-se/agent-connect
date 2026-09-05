import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { linkCodexAuth } from "./link-codex-auth.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-connect-auth-test-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(source);
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(source, "auth.json"), "dummy-v1", { mode: 0o640 });
  fs.writeFileSync(path.join(source, "config.toml"), "source config");
  fs.writeFileSync(path.join(source, "history.jsonl"), "source history");
  return {
    root,
    source,
    runtime,
    auth: path.join(source, "auth.json"),
    target: path.join(runtime, "auth.json"),
  };
}

test("shares updates, source replacements and writes without sharing config/history", (t) => {
  const f = fixture(t);
  const originalMode = fs.statSync(f.auth).mode;
  assert.equal(linkCodexAuth(f.source, f.runtime).linked, true);
  assert.equal(linkCodexAuth(f.source, f.runtime).linked, false);
  assert.equal(fs.statSync(f.auth).mode, originalMode);
  fs.writeFileSync(f.auth, "dummy-refresh");
  assert.equal(fs.readFileSync(f.target, "utf8"), "dummy-refresh");
  const replacement = path.join(f.source, "replacement");
  fs.writeFileSync(replacement, "dummy-replacement");
  fs.renameSync(replacement, f.auth);
  assert.equal(fs.readFileSync(f.target, "utf8"), "dummy-replacement");
  fs.writeFileSync(f.target, "dummy-write-through");
  assert.equal(fs.readFileSync(f.auth, "utf8"), "dummy-write-through");
  assert.deepEqual(fs.readdirSync(f.runtime), ["auth.json"]);
  assert.equal(
    fs.readFileSync(path.join(f.source, "config.toml"), "utf8"),
    "source config",
  );
  assert.equal(
    fs.readFileSync(path.join(f.source, "history.jsonl"), "utf8"),
    "source history",
  );
});

test("refuses same/aliased homes, missing sources and unexpected destinations", (t) => {
  const f = fixture(t);
  assert.throws(() => linkCodexAuth(f.source, f.source), /distinct/);
  const alias = path.join(f.root, "alias");
  fs.symlinkSync(f.source, alias);
  assert.throws(() => linkCodexAuth(f.source, alias), /distinct/);
  assert.throws(
    () => linkCodexAuth(path.join(f.root, "missing"), f.runtime),
    /missing/,
  );
  fs.mkdirSync(f.target);
  assert.throws(
    () => linkCodexAuth(f.source, f.runtime, { migrate: true }),
    /refusing/,
  );
  fs.rmdirSync(f.target);
  fs.symlinkSync(path.join(f.root, "unexpected"), f.target);
  assert.throws(
    () => linkCodexAuth(f.source, f.runtime, { migrate: true }),
    /unexpected/,
  );
  fs.unlinkSync(f.target);
  fs.linkSync(f.auth, f.target);
  assert.throws(
    () => linkCodexAuth(f.source, f.runtime, { migrate: true }),
    /aliases/,
  );
  fs.unlinkSync(f.auth);
  assert.throws(() => linkCodexAuth(f.source, f.runtime), /Keyring-only/);
});

test("migration is explicit, recoverable, private and idempotent", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.target, "dummy-old-runtime", { mode: 0o644 });
  assert.throws(() => linkCodexAuth(f.source, f.runtime), /--migrate/);
  assert.equal(fs.readFileSync(f.target, "utf8"), "dummy-old-runtime");
  const result = linkCodexAuth(f.source, f.runtime, { migrate: true });
  assert.equal(fs.readFileSync(result.backup, "utf8"), "dummy-old-runtime");
  assert.equal(fs.statSync(result.backup).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(result.backup)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.auth).mode & 0o777, 0o640);
  assert.equal(
    linkCodexAuth(f.source, f.runtime, { migrate: true }).linked,
    false,
  );
  fs.unlinkSync(f.target);
  fs.writeFileSync(f.target, "dummy-second-runtime");
  const second = linkCodexAuth(f.source, f.runtime, { migrate: true });
  assert.notEqual(second.backup, result.backup);
  assert.equal(fs.readFileSync(result.backup, "utf8"), "dummy-old-runtime");
});

test("failed symlink creation restores original runtime credentials", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.target, "dummy-old-runtime");
  assert.throws(
    () =>
      linkCodexAuth(f.source, f.runtime, {
        migrate: true,
        createLink() {
          throw Object.assign(new Error("injected"), { code: "EPERM" });
        },
      }),
    /original runtime auth restored/,
  );
  assert.equal(fs.readFileSync(f.target, "utf8"), "dummy-old-runtime");
  assert.equal(fs.readFileSync(f.auth, "utf8"), "dummy-v1");
  assert.deepEqual(fs.readdirSync(f.runtime), ["auth.json"]);
});

test("CLI wrapper enforces file storage before app-server startup", (t) => {
  const f = fixture(t);
  const binary = path.join(f.root, "dummy-codex");
  fs.writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  const wrapper = fileURLToPath(
    new URL("./codex-file-auth.sh", import.meta.url),
  );
  const result = spawnSync("sh", [wrapper, "app-server"], {
    env: { ...process.env, AGENT_CONNECT_CODEX_BINARY: binary },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "-c",
    'cli_auth_credentials_store="file"',
    "app-server",
  ]);
});
