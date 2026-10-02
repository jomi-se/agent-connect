import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const binary = resolve(
  import.meta.dirname,
  "../target/debug/agent-connect-gateway",
);
test("login invokes only the provider CLI with a private shared home and host UID", async () => {
  const root = await mkdtemp(join(tmpdir(), "acp-login-command-"));
  const home = join(root, "dedicated");
  await mkdir(join(root, "bin"));
  const docker = join(root, "bin/docker");
  await writeFile(docker, '#!/bin/sh\nprintf "%s\\n" "$@" > "$LOGIN_ARGS"\n');
  await chmod(docker, 0o755);
  for (const harness of ["codex", "claude"]) {
    const result = spawnSync(
      binary,
      ["login", "--harness", harness, "--harness-home", home],
      {
        encoding: "utf8",
        env: {
          PATH: join(root, "bin"),
          LOGIN_ARGS: join(root, "args"),
          ANTHROPIC_API_KEY: "must-not-enter-container",
          OPENAI_API_KEY: "must-not-enter-container",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const args = (await readFile(join(root, "args"), "utf8"))
      .trim()
      .split("\n");
    assert.ok(args.includes(`type=bind,src=${home},dst=/home/node`));
    assert.ok(args.includes(`${process.getuid()}:${process.getgid()}`));
    assert.ok(args.includes("-it"));
    assert.ok(
      !args.some(
        (arg) => arg.includes("API_KEY") || arg.includes("must-not-enter"),
      ),
    );
    assert.deepEqual(
      args.slice(harness === "codex" ? -3 : -2),
      harness === "codex"
        ? ["codex", "login", "--device-auth"]
        : ["claude", "/login"],
    );
  }
  await chmod(home, 0o755);
  const refused = spawnSync(
    binary,
    ["login", "--harness", "codex", "--harness-home", home],
    { encoding: "utf8" },
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /0700/);
});
