import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { steps, verify } from "./verify.mjs";

for (const failure of [undefined, "build", "test:ui:owner"]) {
  test(`verify builds one checkout box and cleans it after ${failure ?? "success"}`, async () => {
    const repository = await mkdtemp(join(tmpdir(), "verify-wrapper-test-"));
    const calls = [];
    const images = new Set(["agent-connect-box:0.0.1"]);
    let work;
    try {
      const sources = {
        "deploy/gateway/box/package.json": '{"version":"0.0.1"}',
        "deploy/gateway/box/Dockerfile": "checkout Dockerfile",
        "deploy/gateway/box/package-lock.json": "checkout lockfile",
        "deploy/gateway/box/entrypoint.sh": "checkout entrypoint",
        "deploy/gateway/egress-proxy.mjs": "checkout proxy",
        "deploy/gateway/test/fixtures/codex-config.toml": "checkout config",
      };
      for (const [path, contents] of Object.entries(sources)) {
        await mkdir(dirname(join(repository, path)), { recursive: true });
        await writeFile(join(repository, path), contents);
      }
      const error = Object.assign(
        new Error("intentional verification failure"),
        { exitCode: 17 },
      );
      const run = async (binary, args, options) => {
        calls.push({ binary, args, image: options.env.ACP_BOX_IMAGE });
        assert.equal(options.cwd, repository);
        assert.match(
          options.env.ACP_BOX_IMAGE,
          /^agent-connect-box-test:0\.0\.1-[a-f0-9-]{36}$/,
        );
        if (binary === "./deploy/gateway/box/build-local.sh") {
          await mkdir(join(repository, "target/distrib"), { recursive: true });
          await writeFile(
            join(repository, "target/distrib/session-runner-linux-arm64"),
            "fresh checkout runner",
          );
        } else if (binary === "docker") {
          work = dirname(options.env.DOCKER_CONFIG);
          if (args[0] === "info") return "aarch64\n";
          if (args[0] === "build") {
            const image = args[args.indexOf("--tag") + 1];
            assert.equal(image, options.env.ACP_BOX_IMAGE);
            assert.deepEqual(args.slice(1, 3), ["--platform", "linux/arm64"]);
            const context = args.at(-1);
            assert.equal(
              await readFile(join(context, "Dockerfile"), "utf8"),
              "checkout Dockerfile",
            );
            assert.equal(
              await readFile(join(context, "egress-proxy.mjs"), "utf8"),
              "checkout proxy",
            );
            assert.equal(
              await readFile(join(context, "mock-codex-config.toml"), "utf8"),
              "checkout config",
            );
            assert.equal(
              await readFile(join(context, "session-runner"), "utf8"),
              "fresh checkout runner",
            );
            images.add(image);
            if (failure === "build") throw error;
          } else if (args[1] === "ls") return [...images].join("\n");
          else if (args[1] === "rm") {
            assert.equal(args[2], options.env.ACP_BOX_IMAGE);
            assert.ok(images.delete(args[2]));
          }
        } else if (binary === "npm" && args[1] === failure) throw error;
        return "";
      };
      if (failure)
        await assert.rejects(
          verify({ repository, run }),
          (actual) => actual === error && actual.exitCode === 17,
        );
      else await verify({ repository, run });
      assert.deepEqual([...images], ["agent-connect-box:0.0.1"]);
      assert.equal(
        calls.filter(
          (call) => call.binary === "docker" && call.args[0] === "build",
        ).length,
        1,
      );
      assert.equal(new Set(calls.map((call) => call.image)).size, 1);
      assert.equal(
        calls.filter(
          (call) => call.binary === "docker" && call.args[1] === "rm",
        ).length,
        1,
      );
      await assert.rejects(stat(work), { code: "ENOENT" });
      if (!failure)
        assert.deepEqual(
          calls
            .filter((call) => call.binary === "npm")
            .map((call) => call.args[1]),
          steps,
        );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
}

for (const path of [
  "scripts/gateway-scenarios.mjs",
  "scripts/gateway-teardown.mjs",
  "scripts/owner-ui.mjs",
  "deploy/gateway/test/box.test.mjs",
]) {
  test(`${path} rejects a missing ACP_BOX_IMAGE before launching tools`, () => {
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "..", path)],
      {
        env: { PATH: "/nonexistent" },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ACP_BOX_IMAGE is required/);
  });
}

test("verify runs only the selected steps", async () => {
  const repository = await mkdtemp(join(tmpdir(), "verify-select-test-"));
  try {
    for (const path of [
      "deploy/gateway/box/Dockerfile",
      "deploy/gateway/box/package-lock.json",
      "deploy/gateway/box/entrypoint.sh",
      "deploy/gateway/egress-proxy.mjs",
      "deploy/gateway/test/fixtures/codex-config.toml",
      "target/distrib/session-runner-linux-amd64",
    ]) {
      await mkdir(dirname(join(repository, path)), { recursive: true });
      await writeFile(join(repository, path), "");
    }
    await writeFile(
      join(repository, "deploy/gateway/box/package.json"),
      '{"version":"0.0.1"}',
    );
    const npm = [];
    const run = async (binary, args) => {
      if (binary === "npm") npm.push(args[1]);
      if (binary === "docker" && args[0] === "info") return "x86_64\n";
      return "";
    };
    await verify({
      repository,
      run,
      only: ["test:integration:gateway:boxed"],
    });
    assert.deepEqual(npm, ["test:integration:gateway:boxed"]);
    await assert.rejects(
      verify({ repository, run, only: ["boxed"] }),
      /Unknown verify step: boxed/,
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
