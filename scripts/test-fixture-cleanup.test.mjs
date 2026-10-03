import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  pruneTestInstallations,
  runCleanupTasks,
} from "./test-fixture-cleanup.mjs";

test("fixture teardown drops heavy installs and caches while retaining evidence and linked external data", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "ac-fixture-cleanup-"));
  try {
    const fixture = join(sandbox, "fixture");
    const external = join(sandbox, "external");
    for (const path of [
      "adapters/node_modules/adapter",
      "web/node_modules/browser",
      "state/extensions/plugin/node_modules/dependency",
      "cache",
      "npm-cache",
      "node-compile-cache/openclaw",
      "state/cache",
      ".cache",
      ".npm",
      "reports",
      "state",
    ])
      await mkdir(join(fixture, path), { recursive: true });
    await mkdir(join(external, "node_modules"), { recursive: true });
    await writeFile(join(external, "node_modules/shared"), "shared dependency");
    await symlink(external, join(fixture, "shared"), "dir");
    await symlink(external, join(fixture, "node_modules"), "dir");
    await writeFile(join(fixture, "gateway.log"), "startup failure evidence");
    await writeFile(join(fixture, "reports/chat.json"), '{"status":"failed"}');
    await writeFile(
      join(fixture, "state/session.json"),
      "synthetic fixture state",
    );
    await pruneTestInstallations(fixture, { keepInstallations: true });
    assert.ok(
      (await lstat(join(fixture, "adapters/node_modules"))).isDirectory(),
    );
    await pruneTestInstallations(fixture, { keepInstallations: false });
    for (const path of [
      "node_modules",
      "adapters/node_modules",
      "web/node_modules",
      "state/extensions/plugin/node_modules",
      "cache",
      "npm-cache",
      "node-compile-cache",
      "state/cache",
      ".cache",
      ".npm",
    ])
      await assert.rejects(lstat(join(fixture, path)), { code: "ENOENT" });
    assert.equal(
      await readFile(join(fixture, "gateway.log"), "utf8"),
      "startup failure evidence",
    );
    assert.equal(
      await readFile(join(fixture, "reports/chat.json"), "utf8"),
      '{"status":"failed"}',
    );
    assert.equal(
      await readFile(join(fixture, "state/session.json"), "utf8"),
      "synthetic fixture state",
    );
    assert.equal(
      await readFile(join(external, "node_modules/shared"), "utf8"),
      "shared dependency",
    );
    assert.ok((await lstat(join(fixture, "shared"))).isSymbolicLink());
    await pruneTestInstallations(fixture, { keepInstallations: false });
    await pruneTestInstallations(join(sandbox, "absent"), {
      keepInstallations: false,
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

for (const allocated of [false, true]) {
  test(`egress cleanup failure ${allocated ? "after allocation" : "after missing-image allocation refusal"} does not skip owned gateways`, async () => {
    const completed = [];
    const absentContainer = new Error("container absent");
    let releaseGateway;
    const primaryStopped = new Promise((resolve) => {
      releaseGateway = resolve;
    });
    const cleanup = runCleanupTasks([
      async () => {
        await primaryStopped;
        completed.push("primary gateway");
      },
      async () => {
        if (allocated) {
          await Promise.resolve();
          completed.push("problem gateway");
        }
      },
      () => {
        throw absentContainer;
      },
    ]);
    const rejected = assert.rejects(cleanup, (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [absentContainer]);
      assert.deepEqual(
        completed.sort(),
        allocated
          ? ["primary gateway", "problem gateway"]
          : ["primary gateway"],
      );
      return true;
    });
    releaseGateway();
    await rejected;
  });
}

test("a synchronous browser-close failure still attempts every process cleanup and retains both failures", async () => {
  const stopped = [];
  const browserFailure = new Error("browser close failed");
  const egressFailure = new Error("owned egress cleanup failed");
  await assert.rejects(
    runCleanupTasks([
      () => {
        throw browserFailure;
      },
      () => {
        stopped.push("primary gateway");
      },
      () => {
        stopped.push("problem gateway");
      },
      () => {
        throw egressFailure;
      },
    ]),
    (error) => {
      assert.deepEqual(stopped, ["primary gateway", "problem gateway"]);
      assert.deepEqual(error.errors, [browserFailure, egressFailure]);
      return true;
    },
  );
});
