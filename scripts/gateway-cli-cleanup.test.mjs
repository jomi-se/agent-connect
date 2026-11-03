import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

for (const fail of [false, true]) {
  test(`CLI suite cleans its owned roots after ${fail ? "an assertion failure" : "success"}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cli-cleanup-regression-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const temporary = join(root, "temporary");
    const foreign = join(temporary, "acp-init-foreign-sentinel");
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "keep"), "foreign fixture must survive");
    const events = join(root, "calls.jsonl");
    const binary = join(root, "fake-gateway");
    // This double exercises only the suite's cleanup lifecycle. The selected
    // refusal test expects exit 2; exit 0 triggers a real assertion failure.
    await writeFile(
      binary,
      `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] !== 'setup') throw new Error('Unexpected fixture command');
const runtime = args[args.indexOf('--directory') + 1];
const owned = path.dirname(runtime);
fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({ home: process.env.HOME, root: owned }) + '\\n');
const link = path.join(owned, 'foreign-link');
if (!fs.existsSync(link)) fs.symlinkSync(${JSON.stringify(foreign)}, link);
console.error('first-time setup needs the owner at a terminal');
process.exit(${fail ? 0 : 2});
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-name-pattern=^owner setup rejects unattended prompts and invalid public origins before creation$",
        fileURLToPath(new URL("./gateway-cli.test.mjs", import.meta.url)),
      ],
      {
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => name !== "NODE_TEST_CONTEXT",
            ),
          ),
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
          ACP_GATEWAY_MODE: "release-artifacts",
          ACP_GATEWAY_BIN: binary,
        },
        encoding: "utf8",
        timeout: 20000,
      },
    );
    assert.equal(result.status, fail ? 1 : 0, result.stderr || result.stdout);
    if (fail) assert.match(result.stdout, /ERR_ASSERTION|AssertionError/);
    const calls = (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, fail ? 1 : 5);
    const owned = new Set(calls.flatMap((call) => [call.home, call.root]));
    assert.equal(
      owned.size,
      2,
      "both suite HOME and per-test root were allocated",
    );
    for (const path of owned) {
      assert.equal(join(path, ".."), temporary);
      await assert.rejects(access(path), { code: "ENOENT" });
    }
    assert.equal(
      await readFile(join(foreign, "keep"), "utf8"),
      "foreign fixture must survive",
    );
    assert.deepEqual(await readdir(temporary), ["acp-init-foreign-sentinel"]);
  });
}

for (const mode of [
  "delayed close",
  "startup timeout",
  "forced stop",
  "unconfirmed close",
]) {
  test(`CLI startup cleanup waits for ${mode}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cli-child-cleanup-"));
    const events = join(root, "calls.jsonl");
    t.after(async () => {
      let calls = [];
      try {
        calls = (await readFile(events, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      // Faults in this regression must not orphan its real synthetic children.
      for (const pid of new Set(
        calls.filter((call) => call.pid).map((call) => call.pid),
      )) {
        const { setTimeout: delay } = await import("node:timers/promises");
        let stopped = false;
        for (let attempt = 0; attempt < 40; attempt++) {
          try {
            process.kill(pid, attempt === 0 ? "SIGKILL" : 0);
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
            stopped = true;
            break;
          }
          await delay(50);
        }
        assert.ok(
          stopped,
          "preserving regression roots until fixture child stops",
        );
      }
      await rm(root, { recursive: true, force: true });
    });
    const temporary = join(root, "temporary");
    const foreign = join(temporary, "foreign");
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "keep"), "sentinel");
    const binary = join(root, "fake-gateway");
    await writeFile(
      binary,
      `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
const record = (value) => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify(value) + '\\n');
if (args[0] === 'serve') {
  // The selected test writes its runtime at <root>/runtime/config.json.
  const config = args.includes('--config')
    ? args[args.indexOf('--config') + 1]
    : process.env.AGENT_CONNECT_CONFIG;
  record({ root: path.dirname(path.dirname(config)), home: process.env.HOME });
  record({ pid: process.pid });
  process.on('SIGTERM', () => {
    record({ signal: 'SIGTERM', homeExists: fs.existsSync(process.env.HOME) });
    if (mode === 'forced stop' || mode === 'unconfirmed close') return;
    setTimeout(() => {
      record({ closing: true, homeExists: fs.existsSync(process.env.HOME) });
      process.exit(0);
    }, 150);
  });
  if (mode !== 'startup timeout') console.error('listening on ws://127.0.0.1:0/acp');
  setInterval(() => {}, 1000);
} else throw new Error('Unexpected fixture command');
`,
      { mode: 0o755 },
    );
    const preload = join(root, "withhold-close.mjs");
    if (mode === "unconfirmed close") {
      // Real SIGKILL stops the OS child. Withhold only the close acknowledgement
      // to exercise the suite's conservative preservation branch deterministically.
      await writeFile(
        preload,
        `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = cp.spawn;
cp.spawn = (binary, ...args) => {
  const child = spawn(binary, ...args);
  if (binary === ${JSON.stringify(binary)}) {
    const once = child.once;
    child.once = function(event, listener) {
      return event === 'close' ? this : once.call(this, event, listener);
    };
  }
  return child;
};
syncBuiltinESMExports();
`,
      );
    }
    const result = spawnSync(
      process.execPath,
      [
        ...(mode === "unconfirmed close" ? ["--import", preload] : []),
        "--test",
        "--test-name-pattern=^CLI overrides environment, environment overrides JSON, and paths follow config directory$",
        fileURLToPath(new URL("./gateway-cli.test.mjs", import.meta.url)),
      ],
      {
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => name !== "NODE_TEST_CONTEXT",
            ),
          ),
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
          ACP_GATEWAY_MODE: "release-artifacts",
          ACP_GATEWAY_BIN: binary,
        },
        encoding: "utf8",
        timeout: 20000,
      },
    );
    assert.equal(
      result.status,
      mode === "delayed close" ? 0 : 1,
      result.stderr || result.stdout,
    );
    const calls = (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const allocation = calls.find((call) => call.root);
    assert.ok(allocation);
    const signals = calls.filter((call) => call.signal);
    assert.ok(signals.length);
    assert.ok(signals.every((call) => call.homeExists));
    for (const call of calls.filter((call) => call.pid)) {
      assert.throws(() => process.kill(call.pid, 0), { code: "ESRCH" });
    }
    if (mode === "delayed close" || mode === "startup timeout") {
      const closes = calls.filter((call) => call.closing);
      assert.equal(closes.length, mode === "delayed close" ? 3 : 1);
      assert.ok(closes.every((call) => call.homeExists));
    }
    if (mode === "startup timeout")
      assert.match(result.stdout, /server startup timed out/);
    for (const owned of [allocation.home, allocation.root]) {
      if (mode === "unconfirmed close") await access(owned);
      else await assert.rejects(access(owned), { code: "ENOENT" });
    }
    if (mode === "unconfirmed close")
      assert.match(result.stdout, /close was not confirmed; preserving/);
    else assert.deepEqual(await readdir(temporary), ["foreign"]);
    assert.equal(await readFile(join(foreign, "keep"), "utf8"), "sentinel");
  });
}
