import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  releaseTargets,
  releaseInfoFilename,
  verifyArchiveReleaseInfo,
} from "./acp-release-info.mjs";
const version = "0.1.0-alpha.1";
const sessionImage = `agent-connect-session:${version}`;
const hostTarget = Object.entries(releaseTargets).find(
  ([, [os, arch]]) => os === process.platform && arch === process.arch,
)?.[0];
const foreignTarget = Object.keys(releaseTargets).find(
  (target) => target !== hostTarget,
);
async function fixture(t, target, info = { version, sessionImage }) {
  const directory = await mkdtemp(join(tmpdir(), "acp-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = join(directory, "files");
  await mkdir(files);
  const executable = `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(info)}'\n`;
  for (const name of ["agent-connect", "agent-connect-gateway"]) {
    await writeFile(join(files, name), executable);
    await chmod(join(files, name), 0o755);
  }
  const archive = join(directory, `agent-connect-gateway-${target}.tar.xz`);
  const result = spawnSync(
    "tar",
    ["-cJf", archive, "-C", files, "agent-connect", "agent-connect-gateway"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return { directory, files, archive, target, version, sessionImage };
}
test(
  "native release-info evidence is emitted only after both executables agree",
  { skip: !hostTarget },
  async (t) => {
    const input = await fixture(t, hostTarget);
    const info = await verifyArchiveReleaseInfo({ ...input, record: true });
    assert.equal(info.version, version);
    assert.equal(info.sessionImage, sessionImage);
    assert.equal(info.target, hostTarget);
    assert.equal(
      info.binarySha256,
      createHash("sha256")
        .update(await readFile(join(input.files, "agent-connect-gateway")))
        .digest("hex"),
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(input.directory, releaseInfoFilename(hostTarget)),
          "utf8",
        ),
      ),
      info,
    );
  },
);
for (const [field, replacement, message] of [
  ["version", "9.9.9", /version mismatch/],
  ["sessionImage", "agent-connect-session:wrong", /session image mismatch/],
]) {
  test(
    `pack rejects compiled ${field} mismatch before creating packages`,
    { skip: !hostTarget },
    async (t) => {
      const input = await fixture(t, hostTarget, {
        version,
        sessionImage,
        [field]: replacement,
      });
      const output = join(input.directory, "output");
      const result = spawnSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "acp-release.mjs"),
          "pack",
          "--local",
          "--image",
          sessionImage,
          "--artifacts",
          input.directory,
          "--directory",
          output,
        ],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
      await assert.rejects(access(output), { code: "ENOENT" });
    },
  );
}
test("cross-target packaging requires evidence bound to both executable hashes", async (t) => {
  const input = await fixture(t, foreignTarget);
  await assert.rejects(
    verifyArchiveReleaseInfo(input),
    /Missing or invalid release-info evidence/,
  );
  const hash = createHash("sha256")
    .update(await readFile(join(input.files, "agent-connect")))
    .digest("hex");
  const info = {
    schemaVersion: 1,
    target: foreignTarget,
    version,
    sessionImage,
    primarySha256: hash,
    binarySha256: hash,
  };
  const path = join(input.directory, releaseInfoFilename(foreignTarget));
  await writeFile(path, JSON.stringify(info));
  assert.deepEqual(await verifyArchiveReleaseInfo(input), info);
  for (const [field, replacement, message] of [
    ["binarySha256", "0".repeat(64), /does not match archive/],
    ["primarySha256", "0".repeat(64), /does not match archive/],
    ["target", hostTarget, /does not match archive/],
    ["version", "9.9.9", /version mismatch/],
    ["sessionImage", "wrong", /session image mismatch/],
  ]) {
    await writeFile(path, JSON.stringify({ ...info, [field]: replacement }));
    await assert.rejects(verifyArchiveReleaseInfo(input), message);
  }
});
test("cross-target evidence rejects oversized or unknown fields", async (t) => {
  const input = await fixture(t, foreignTarget);
  const path = join(input.directory, releaseInfoFilename(foreignTarget));
  await writeFile(path, " ".repeat(16 * 1024 + 1));
  await assert.rejects(
    verifyArchiveReleaseInfo(input),
    /Missing or invalid release-info evidence/,
  );
  await writeFile(path, JSON.stringify({ schemaVersion: 1, unexpected: true }));
  await assert.rejects(
    verifyArchiveReleaseInfo(input),
    /Missing or invalid release-info evidence/,
  );
});
test(
  "native packing re-executes release-info despite a forged sidecar",
  { skip: !hostTarget },
  async (t) => {
    const input = await fixture(t, hostTarget, {
      version,
      sessionImage: "wrong",
    });
    await writeFile(
      join(input.directory, releaseInfoFilename(hostTarget)),
      JSON.stringify({
        schemaVersion: 1,
        target: hostTarget,
        version,
        sessionImage,
      }),
    );
    await assert.rejects(
      verifyArchiveReleaseInfo(input),
      /session image mismatch/,
    );
  },
);
