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
} from "./release-info.mjs";
const version = "0.0.1";
const hostTarget = Object.entries(releaseTargets).find(
  ([, [os, arch]]) => os === process.platform && arch === process.arch,
)?.[0];
const foreignTarget = Object.keys(releaseTargets).find(
  (target) => target !== hostTarget,
);
async function fixture(t, target, info = { version }) {
  const directory = await mkdtemp(join(tmpdir(), "release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = join(directory, "files");
  await mkdir(files);
  const executable = `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(info)}'\n`;
  for (const name of ["agent-connect"]) {
    await writeFile(join(files, name), executable);
    await chmod(join(files, name), 0o755);
  }
  const archive = join(directory, `agent-connect-gateway-${target}.tar.xz`);
  const result = spawnSync(
    "tar",
    ["-cJf", archive, "-C", files, "agent-connect"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return { directory, files, archive, target, version };
}
test(
  "native release-info evidence is emitted only after the executable reports matching defaults",
  { skip: !hostTarget },
  async (t) => {
    const input = await fixture(t, hostTarget);
    const info = await verifyArchiveReleaseInfo({ ...input, record: true });
    assert.equal(info.version, version);
    assert.equal(info.target, hostTarget);
    assert.equal(
      info.binarySha256,
      createHash("sha256")
        .update(await readFile(join(input.files, "agent-connect")))
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
]) {
  test(
    `pack rejects compiled ${field} mismatch before creating packages`,
    { skip: !hostTarget },
    async (t) => {
      const input = await fixture(t, hostTarget, {
        version,
        [field]: replacement,
      });
      const output = join(input.directory, "output");
      const result = spawnSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "release.mjs"),
          "pack",
          "--local",
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
test("cross-target packaging requires evidence bound to the executable hash", async (t) => {
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
    binarySha256: hash,
  };
  const path = join(input.directory, releaseInfoFilename(foreignTarget));
  await writeFile(path, JSON.stringify(info));
  assert.deepEqual(await verifyArchiveReleaseInfo(input), info);
  for (const [field, replacement, message] of [
    ["binarySha256", "0".repeat(64), /does not match archive/],
    ["target", hostTarget, /does not match archive/],
    ["version", "9.9.9", /version mismatch/],
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
      version: "wrong",
    });
    await writeFile(
      join(input.directory, releaseInfoFilename(hostTarget)),
      JSON.stringify({
        schemaVersion: 1,
        target: hostTarget,
        version,
      }),
    );
    await assert.rejects(verifyArchiveReleaseInfo(input), /version mismatch/);
  },
);

test("release checks accept independent SDK versions and reject gateway/box drift", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "acp-version-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const folder of [
    "scripts",
    "packages/web-sdk",
    "packages/gateway-npm",
    "deploy/gateway/box",
    "crates/gateway",
    "examples/acp-chat",
  ])
    await mkdir(join(directory, folder), { recursive: true });
  for (const script of ["release.mjs", "release-info.mjs"])
    await writeFile(
      join(directory, "scripts", script),
      await readFile(new URL(script, import.meta.url)),
    );
  const manifest = async (file, value) =>
    writeFile(join(directory, file), JSON.stringify(value));
  await manifest("packages/web-sdk/package.json", { version: "0.0.10" });
  await manifest("packages/gateway-npm/package.json", {
    version: "0.0.1",
    agentConnect: { adapterVersions: { "fixture-adapter": "2.0.1" } },
  });
  await manifest("deploy/gateway/box/package.json", {
    version: "0.0.1",
    dependencies: { "fixture-adapter": "2.0.1" },
  });
  await manifest("examples/acp-chat/package.json", { version: "0.0.1" });
  await writeFile(
    join(directory, "crates/gateway/Cargo.toml"),
    '[package]\nversion = "0.0.1"\n',
  );
  const check = () =>
    spawnSync(
      process.execPath,
      [join(directory, "scripts/release.mjs"), "check"],
      { encoding: "utf8" },
    );
  assert.equal(check().status, 0);
  await manifest("packages/web-sdk/package.json", { version: "1.0.0" });
  const sdkDrift = check();
  assert.notEqual(sdkDrift.status, 0);
  assert.match(sdkDrift.stderr, /independently versioned 0.0.x/);
  await manifest("packages/web-sdk/package.json", { version: "0.0.10" });
  await manifest("deploy/gateway/box/package.json", {
    version: "0.0.2",
    dependencies: { "fixture-adapter": "2.0.1" },
  });
  const boxDrift = check();
  assert.notEqual(boxDrift.status, 0);
  assert.match(boxDrift.stderr, /must share one version/);
  await manifest("deploy/gateway/box/package.json", {
    version: "0.0.1",
    dependencies: { "fixture-adapter": "2.0.1" },
  });
  await manifest("examples/acp-chat/package.json", { version: "0.0.2" });
  const sampleDrift = check();
  assert.notEqual(sampleDrift.status, 0);
  assert.match(sampleDrift.stderr, /must share one version/);
});

for (const prefix of ["/home/example/", "/Users/example/"]) {
  test(
    `release evidence rejects an executable containing ${prefix}`,
    { skip: !hostTarget },
    async (t) => {
      const input = await fixture(t, hostTarget);
      const file = join(input.files, "agent-connect");
      await writeFile(
        file,
        (await readFile(file, "utf8")) + `# builder: ${prefix}repository\n`,
      );
      assert.equal(
        spawnSync("tar", [
          "-cJf",
          input.archive,
          "-C",
          input.files,
          "agent-connect",
        ]).status,
        0,
      );
      await assert.rejects(
        verifyArchiveReleaseInfo({ ...input, record: true }),
        /personal builder path/,
      );
      await assert.rejects(
        access(join(input.directory, releaseInfoFilename(hostTarget))),
        { code: "ENOENT" },
      );
    },
  );
}

test(
  "release evidence permits the fixed container home without permitting similarly named builder homes",
  { skip: !hostTarget },
  async (t) => {
    const input = await fixture(t, hostTarget);
    const file = join(input.files, "agent-connect");
    const original = await readFile(file, "utf8");
    for (const [path, permitted] of [
      ["/home/node", true],
      ["/home/node/.codex", true],
      ["/home/node--device-auth", true],
      ["/home/node:rw,exec", true],
      ["/home/node-builder/repository", false],
    ]) {
      await writeFile(file, original + `# ${path}\n`);
      assert.equal(
        spawnSync("tar", [
          "-cJf",
          input.archive,
          "-C",
          input.files,
          "agent-connect",
        ]).status,
        0,
      );
      if (permitted) await verifyArchiveReleaseInfo(input);
      else
        await assert.rejects(
          verifyArchiveReleaseInfo(input),
          /personal builder path/,
        );
    }
  },
);
