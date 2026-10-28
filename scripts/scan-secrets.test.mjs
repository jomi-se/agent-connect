import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scan = fileURLToPath(new URL("./scan-secrets.sh", import.meta.url));
const install = fileURLToPath(
  new URL("./install-gitleaks.sh", import.meta.url),
);

test("scanner and installer share the canonical Git directory across worktrees", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gitleaks-worktree-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "main checkout");
  const worktree = join(root, "linked checkout");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const capture = join(root, "scanner-call.json");
  await mkdir(home);
  await mkdir(bin);
  const env = {
    HOME: home,
    PATH: bin,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    TEST_SCANNER_CAPTURE: capture,
  };
  // Only these tools are available: a missing scanner cannot find a real one,
  // and the installer cannot download anything if its existing-file check fails.
  for (const command of ["git", "uname"]) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
      encoding: "utf8",
    });
    assert.equal(found.status, 0, found.stderr);
    await symlink(found.stdout.trim(), join(bin, command));
  }
  const git = (args, cwd = root) => {
    const result = spawnSync(join(bin, "git"), args, {
      cwd,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "--quiet", repository]);
  git(
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    repository,
  );
  git(
    [
      "-c",
      "core.hooksPath=/dev/null",
      "worktree",
      "add",
      "--quiet",
      "--detach",
      worktree,
    ],
    repository,
  );
  const nested = join(worktree, "nested directory");
  await mkdir(nested);
  const common = git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    worktree,
  );
  assert.notEqual(common, git(["rev-parse", "--absolute-git-dir"], worktree));
  const localScanner = join(common, "agent-connect-tools", "gitleaks");
  const fakeScanner = async (path, identity) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.TEST_SCANNER_CAPTURE, JSON.stringify({ identity: ${JSON.stringify(identity)}, cwd: process.cwd(), args: process.argv.slice(2) }));\nif (process.argv[2] === 'version') console.log('8.30.1');\nprocess.exit(Number(process.env.TEST_SCANNER_EXIT || 0));\n`,
      { mode: 0o755 },
    );
  };
  await fakeScanner(localScanner, "common");
  const invoke = async (script, args, cwd, overrides = {}) => {
    await rm(capture, { force: true });
    const result = spawnSync("/bin/sh", [script, ...args], {
      cwd,
      env: { ...env, ...overrides },
      encoding: "utf8",
      timeout: 10000,
    });
    let call;
    try {
      call = JSON.parse(await readFile(capture, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { result, call };
  };
  for (const cwd of [repository, worktree, nested]) {
    const { result, call } = await invoke(scan, ["history"], cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(call, {
      identity: "common",
      cwd: cwd === repository ? repository : worktree,
      args: [
        "git",
        "--log-opts=--all HEAD",
        "--redact",
        "--no-banner",
        "--no-color",
      ],
    });
    const installed = await invoke(install, [], cwd);
    assert.equal(installed.result.status, 0, installed.result.stderr);
    assert.deepEqual(installed.call, {
      identity: "common",
      cwd,
      args: ["version"],
    });
    assert.match(installed.result.stdout, /already installed/);
  }
  const staged = await invoke(scan, ["staged"], nested);
  assert.equal(staged.result.status, 0, staged.result.stderr);
  assert.deepEqual(staged.call.args, [
    "git",
    "--pre-commit",
    "--staged",
    "--redact",
    "--no-banner",
    "--no-color",
  ]);
  const pathScanner = join(bin, "gitleaks");
  await fakeScanner(pathScanner, "PATH");
  const fromPath = await invoke(scan, [], nested);
  assert.equal(fromPath.result.status, 0, fromPath.result.stderr);
  assert.equal(fromPath.call.identity, "PATH");
  const override = join(root, "explicit scanner");
  await fakeScanner(override, "explicit");
  const explicit = await invoke(scan, [], nested, { GITLEAKS_BIN: override });
  assert.equal(explicit.result.status, 0, explicit.result.stderr);
  assert.equal(explicit.call.identity, "explicit");
  const failure = await invoke(scan, [], nested, {
    GITLEAKS_BIN: override,
    TEST_SCANNER_EXIT: "23",
  });
  assert.equal(failure.result.status, 23);
  await chmod(override, 0o644);
  const invalid = await invoke(scan, [], nested, { GITLEAKS_BIN: override });
  assert.equal(invalid.result.status, 1);
  assert.equal(invalid.call, undefined);
  assert.match(invalid.result.stderr, /not executable/);
  const installOverride = join(root, "explicit tools");
  await fakeScanner(join(installOverride, "gitleaks"), "install override");
  const customInstall = await invoke(install, [], nested, {
    GITLEAKS_INSTALL_DIR: installOverride,
  });
  assert.equal(customInstall.result.status, 0, customInstall.result.stderr);
  assert.equal(customInstall.call.identity, "install override");
  const missingOverride = await invoke(scan, [], nested, {
    GITLEAKS_BIN: join(root, "missing scanner"),
  });
  assert.equal(missingOverride.result.status, 1);
  assert.equal(missingOverride.call, undefined);
  assert.match(missingOverride.result.stderr, /not executable/);
  await rm(pathScanner);
  await chmod(localScanner, 0o644);
  for (const missing of [false, true]) {
    if (missing) await rm(localScanner);
    const unavailable = await invoke(scan, [], nested);
    assert.equal(unavailable.result.status, 1);
    assert.equal(unavailable.call, undefined);
    assert.match(unavailable.result.stderr, /Gitleaks is not installed/);
  }
});
