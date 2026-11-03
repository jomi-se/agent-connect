import assert from "node:assert/strict";
import { test } from "node:test";
import { engine } from "./container-engine.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  cleanSourceCommit,
  writeVerificationReceipt,
  prepareReleaseArtifacts,
  readPlatformArchive,
  extractVerificationBinaries,
  receiptFilename,
} from "./verification-artifacts.mjs";
import { gatewayTestBinary } from "./gateway-test-binary.mjs";
import { verify, steps } from "./verify.mjs";
import { releaseTargets, releaseInfoFilename } from "./release-info.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const version = "0.0.1";
const native = "x86_64-unknown-linux-musl";
const arm = "aarch64-unknown-linux-musl";
function tarball(entries, mutate = () => {}) {
  const blocks = [];
  for (const [name, value, type = "0"] of entries) {
    const data = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "ascii");
    header.write("0000755\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(
      data.length.toString(8).padStart(11, "0") + "\0",
      124,
      "ascii",
    );
    header.write("00000000000\0", 136, "ascii");
    header.fill(32, 148, 156);
    header.write(type, 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    header.write(
      [...header]
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
      "ascii",
    );
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  const tar = Buffer.concat([...blocks, Buffer.alloc(1024)]);
  mutate(tar);
  return gzipSync(tar);
}
function platformEntries(target, overrides = {}) {
  const [os, cpu] = releaseTargets[target];
  const gateway = Buffer.from(`gateway:${target}`);
  const runner = Buffer.from(`runner:linux:${cpu}`);
  return [
    ["package/bin/agent-connect", gateway],
    ["package/bin/session-runner", runner],
    ["package/LICENSE", "fixture license"],
    ["package/README.md", "fixture readme"],
    [
      "package/package.json",
      JSON.stringify({
        name: `@open-agent-connect/gateway-${os}-${cpu}`,
        version,
        os: [os],
        cpu: [cpu],
        ...overrides,
      }),
    ],
    [
      "package/SHA256SUMS",
      `${hash(gateway)}  bin/agent-connect\n${hash(runner)}  bin/session-runner\n`,
    ],
  ];
}
async function write(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}
function git(repository, args) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function commit(repository) {
  git(repository, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
}
async function fixture(
  t,
  { targets = [native], overrides, mutateEntries = (entries) => entries } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "artifact-reuse-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repo");
  await mkdir(repository);
  const directory = join(repository, "dist/release");
  const work = join(root, "work");
  await mkdir(work);
  for (const [path, contents] of Object.entries({
    ".gitignore": "dist/\ntarget/\n",
    "packages/gateway-npm/package.json": JSON.stringify({ version }),
    "packages/web-sdk/package.json": JSON.stringify({ version: "0.0.2" }),
    "deploy/gateway/box/package.json": JSON.stringify({ version }),
    "deploy/gateway/box/Dockerfile": "checkout Dockerfile",
    "deploy/gateway/box/entrypoint.sh": "checkout entrypoint",
    "deploy/gateway/box/install-harnesses.sh": "checkout installer",
    "deploy/gateway/egress-proxy.mjs": "checkout proxy",
  }))
    await write(join(repository, path), contents);
  git(repository, ["init", "-q"]);
  git(repository, ["add", ".gitignore", "packages", "deploy"]);
  commit(repository);
  const sourceCommit = await cleanSourceCommit(repository);
  const contents = {
    [`open-agent-connect-gateway-${version}.tgz`]: Buffer.from(
      "packed launcher fixture",
    ),
    "open-agent-connect-web-0.0.2.tgz": Buffer.from("packed SDK fixture"),
    "acp-chat-sample.tgz": Buffer.from("packed sample fixture"),
  };
  for (const target of targets) {
    const [os, cpu] = releaseTargets[target];
    contents[`open-agent-connect-gateway-${os}-${cpu}-${version}.tgz`] =
      tarball(mutateEntries(platformEntries(target, overrides)));
    contents[`agent-connect-gateway-${target}.tar.xz`] = Buffer.from(
      `archive:${target}`,
    );
    contents[releaseInfoFilename(target)] = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        target,
        version,
        binarySha256: hash(`gateway:${target}`),
      }),
    );
  }
  const artifacts = Object.fromEntries(
    Object.entries(contents).map(([name, bytes]) => [
      name,
      { sha256: hash(bytes), size: bytes.length },
    ]),
  );
  contents["release.json"] = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      version,
      sdkVersion: "0.0.2",
      targets: Object.keys(releaseTargets),
      localOnly: true,
      artifacts,
    }),
  );
  contents.SHA256SUMS = Buffer.from(
    Object.entries(artifacts)
      .map(([name, spec]) => `${spec.sha256}  ${name}\n`)
      .join(""),
  );
  for (const [name, bytes] of Object.entries(contents))
    await write(join(directory, name), bytes);
  return { root, repository, directory, work, targets, commit: sourceCommit };
}
async function receipt(f) {
  await writeVerificationReceipt(f);
}

test("receipt binds clean commit, versions, targets and every artifact without paths or itself", async (t) => {
  const f = await fixture(t);
  await receipt(f);
  const text = await readFile(join(f.directory, receiptFilename), "utf8");
  const evidence = JSON.parse(text);
  assert.equal(evidence.commit, f.commit);
  assert.deepEqual(evidence.targets, [native]);
  assert.ok(evidence.artifacts["release.json"]);
  assert.ok(evidence.artifacts.SHA256SUMS);
  assert.ok(!evidence.artifacts[receiptFilename]);
  assert.ok(!text.includes(f.root));
  const prepared = await prepareReleaseArtifacts(f);
  assert.equal(prepared.commit, f.commit);
  assert.equal(
    await readFile(join(prepared.directory, "acp-chat-sample.tgz"), "utf8"),
    "packed sample fixture",
  );
});

test("artifact descriptor reads stay bounded and close across replacement and I/O faults", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "artifact-descriptor-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Export the private reader only in this disposable copy; production API stays narrow.
  const source = (
    await readFile(
      new URL("./verification-artifacts.mjs", import.meta.url),
      "utf8",
    )
  )
    .replace(
      "async function regularFile(",
      "export async function regularFile(",
    )
    .replace(
      'from "./release-info.mjs"',
      `from ${JSON.stringify(new URL("./release-info.mjs", import.meta.url).href)}`,
    );
  const modulePath = join(root, "reader.mjs");
  await writeFile(modulePath, source);
  for (const scenario of [
    "success",
    "partial reads",
    "symlink before open",
    "symlink after stat",
    "growth",
    "shrink",
    "growth at EOF",
    "oversized",
    "directory",
    "fifo",
    "stat failure",
    "read failure",
    "unsupported open",
  ]) {
    await t.test(scenario, () => {
      const script = `
        import fs from 'node:fs';
        import { spawnSync } from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        const scenario = ${JSON.stringify(scenario)};
        const input = ${JSON.stringify(join(root, "input"))};
        const outside = ${JSON.stringify(join(root, "outside"))};
        fs.rmSync(input, { recursive: true, force: true });
        fs.writeFileSync(outside, 'OUT!');
        if (scenario === 'directory') fs.mkdirSync(input);
        else if (scenario === 'fifo') {
          const result = spawnSync('mkfifo', [input]);
          if (result.status !== 0) throw new Error('mkfifo fixture failed');
        } else fs.writeFileSync(input, scenario === 'oversized' ? Buffer.alloc(128) : 'SAFE');
        const nativeOpen = fs.promises.open;
        const nativeReadFile = fs.promises.readFile;
        const report = { opens: 0, closes: 0, pathReads: 0, readBytes: 0, maxRead: 0, fd: null };
        let descriptor;
        fs.promises.readFile = async (path, ...args) => {
          if (String(path) === input) {
            report.pathReads++;
            throw new Error('pathname read forbidden');
          }
          return nativeReadFile(path, ...args);
        };
        fs.promises.open = async (path, ...args) => {
          if (String(path) !== input) return nativeOpen(path, ...args);
          if (scenario === 'unsupported open') throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
          if (scenario === 'symlink before open') {
            fs.unlinkSync(input);
            fs.symlinkSync(outside, input);
          }
          descriptor = await nativeOpen(path, ...args);
          report.opens++;
          const nativeStat = descriptor.stat.bind(descriptor);
          const nativeRead = descriptor.read.bind(descriptor);
          const nativeClose = descriptor.close.bind(descriptor);
          let stats = 0;
          descriptor.stat = async () => {
            if (scenario === 'stat failure') throw new Error('injected stat failure');
            const status = await nativeStat();
            if (++stats === 1) {
              if (scenario === 'symlink after stat') {
                fs.unlinkSync(input);
                fs.symlinkSync(outside, input);
              }
              if (scenario === 'growth') fs.appendFileSync(input, Buffer.alloc(256));
              if (scenario === 'shrink') fs.truncateSync(input, 2);
            }
            return status;
          };
          descriptor.read = async (buffer, offset, length, position) => {
            report.maxRead = Math.max(report.maxRead, length);
            if (scenario === 'read failure') throw new Error('injected read failure');
            const result = await nativeRead(buffer, offset, scenario === 'partial reads' ? Math.min(length, 2) : length, position);
            report.readBytes += result.bytesRead;
            if (scenario === 'growth at EOF' && result.bytesRead === 0) fs.appendFileSync(input, 'X');
            return result;
          };
          descriptor.close = async () => { report.closes++; return nativeClose(); };
          return descriptor;
        };
        syncBuiltinESMExports();
        const { regularFile } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
        try { report.value = (await regularFile(input, 64)).toString(); }
        catch (error) { report.error = error.message; report.code = error.code; }
        report.fd = descriptor?.fd ?? null;
        console.log(JSON.stringify(report));
      `;
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(child.status, 0, child.stderr || child.error?.message);
      const report = JSON.parse(child.stdout);
      assert.equal(report.pathReads, 0);
      assert.equal(report.closes, report.opens);
      assert.equal(report.fd, report.opens ? -1 : null);
      assert.ok(report.readBytes <= 5, JSON.stringify(report));
      assert.ok(report.maxRead <= 5, JSON.stringify(report));
      if (
        ["success", "partial reads", "symlink after stat"].includes(scenario)
      ) {
        assert.equal(report.value, "SAFE");
        assert.equal(report.error, undefined);
      } else {
        assert.equal(report.value, undefined);
        assert.ok(report.error);
        if (scenario === "symlink before open")
          assert.equal(report.code, "ELOOP");
        else if (["growth", "shrink", "growth at EOF"].includes(scenario))
          assert.match(report.error, /changed while reading/);
        else if (["oversized", "directory", "fifo"].includes(scenario))
          assert.match(report.error, /bounded regular file/);
        else if (scenario === "unsupported open")
          assert.match(report.error, /not supported on this filesystem/);
        else assert.match(report.error, /injected/);
      }
    });
  }
});

for (const action of ["producer", "verifier"]) {
  test(`${action} validates the same checksum/evidence bytes it hashes`, async (t) => {
    const f = await fixture(t);
    if (action === "verifier") await receipt(f);
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const original = fs.promises.open;
      const counts = { checksums: 0, evidence: 0 };
      fs.promises.open = async (path, ...args) => {
        if (String(path).endsWith('/SHA256SUMS')) counts.checksums++;
        if (String(path).endsWith('.release-info.json')) counts.evidence++;
        return original(path, ...args);
      };
      syncBuiltinESMExports();
      const api = await import(${JSON.stringify(new URL("./verification-artifacts.mjs", import.meta.url).href)});
      await api.${action === "producer" ? "writeVerificationReceipt" : "prepareReleaseArtifacts"}(${JSON.stringify(f)});
      console.log(JSON.stringify(counts));
    `;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { checksums: 1, evidence: 1 });
  });
}

for (const corruption of [
  "missing receipt",
  "dirty tracked",
  "untracked source",
  "different commit",
  "version",
  "target",
  "hash",
  "release manifest",
  "unexpected file",
  "missing file",
  "symlink",
]) {
  test(`reuse rejects ${corruption}`, async (t) => {
    const f = await fixture(t);
    await receipt(f);
    const path = join(f.directory, receiptFilename);
    const evidence = JSON.parse(await readFile(path, "utf8"));
    if (corruption === "missing receipt") await rm(path);
    if (corruption === "dirty tracked")
      await writeFile(join(f.repository, ".gitignore"), "changed");
    if (corruption === "untracked source")
      await writeFile(join(f.repository, "unexpected-source"), "changed");
    if (corruption === "different commit") {
      git(f.repository, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        "new same-version source",
      ]);
    }
    if (corruption === "version") {
      evidence.version = "0.0.9";
      await writeFile(path, JSON.stringify(evidence));
    }
    if (corruption === "target") {
      evidence.targets = [arm];
      await writeFile(path, JSON.stringify(evidence));
    }
    if (corruption === "hash") {
      evidence.artifacts.SHA256SUMS.sha256 = "0".repeat(64);
      await writeFile(path, JSON.stringify(evidence));
    }
    if (corruption === "release manifest")
      await writeFile(join(f.directory, "release.json"), "{}");
    if (corruption === "unexpected file")
      await writeFile(join(f.directory, "unreceipted.tgz"), "extra");
    if (corruption === "missing file")
      await rm(join(f.directory, "acp-chat-sample.tgz"));
    if (corruption === "symlink") {
      await rm(join(f.directory, "acp-chat-sample.tgz"));
      await symlink(
        join(f.directory, "SHA256SUMS"),
        join(f.directory, "acp-chat-sample.tgz"),
      );
    }
    await assert.rejects(prepareReleaseArtifacts(f));
  });
}

test("producer refuses dirty or changed source before emitting evidence", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repository, "new-source"), "uncommitted");
  await assert.rejects(receipt(f), /clean committed source/);
  await assert.rejects(stat(join(f.directory, receiptFilename)), {
    code: "ENOENT",
  });
  git(f.repository, ["add", "new-source"]);
  commit(f.repository);
  await assert.rejects(receipt(f), /Source commit changed/);
});

for (const invalidMap of ["null", "joined keys", "missing digest"]) {
  test(`receipt rejects ${invalidMap} even with a self-consistent replacement release`, async (t) => {
    const f = await fixture(t);
    await receipt(f);
    const receiptPath = join(f.directory, receiptFilename);
    const evidence = JSON.parse(await readFile(receiptPath, "utf8"));
    const manifest = JSON.parse(
      await readFile(join(f.directory, "release.json"), "utf8"),
    );
    const changed = Buffer.from("replacement sample after receipt creation");
    await writeFile(join(f.directory, "acp-chat-sample.tgz"), changed);
    manifest.artifacts["acp-chat-sample.tgz"] = {
      sha256: hash(changed),
      size: changed.length,
    };
    await writeFile(
      join(f.directory, "release.json"),
      JSON.stringify(manifest),
    );
    await writeFile(
      join(f.directory, "SHA256SUMS"),
      Object.entries(manifest.artifacts)
        .map(([name, value]) => `${value.sha256}  ${name}\n`)
        .join(""),
    );
    if (invalidMap === "null") evidence.artifacts = null;
    if (invalidMap === "joined keys")
      evidence.artifacts = {
        [Object.keys(evidence.artifacts).sort().join(",")]: {
          sha256: "0".repeat(64),
          size: 0,
        },
      };
    if (invalidMap === "missing digest")
      evidence.artifacts["acp-chat-sample.tgz"] = null;
    await writeFile(receiptPath, JSON.stringify(evidence));
    await assert.rejects(prepareReleaseArtifacts(f));
  });
}

test("receipt flag refuses dirty source before tools; default builder still enters its source build", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "build-release-local.mjs",
    "release-build-env.mjs",
    "verification-artifacts.mjs",
    "release-info.mjs",
  ])
    await write(
      join(f.repository, "scripts", name),
      await readFile(join(import.meta.dirname, name)),
    );
  await write(
    join(f.repository, "scripts/release.mjs"),
    "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.BUILD_TRACE, 'check\\n');\n",
  );
  const runner = join(f.repository, "deploy/gateway/box/build-local.sh");
  await write(runner, '#!/bin/sh\nprintf "runner\\n" >> "$BUILD_TRACE"\n');
  await chmod(runner, 0o700);
  git(f.repository, ["add", "scripts", "deploy/gateway/box/build-local.sh"]);
  commit(f.repository);
  await writeFile(join(f.repository, "dirty-source"), "development edit");
  const dist = join(f.root, "fake-dist");
  await writeFile(
    dist,
    '#!/bin/sh\nprintf "dist\\n" >> "$BUILD_TRACE"\nexit 17\n',
    { mode: 0o700 },
  );
  const trace = join(f.root, "build-trace");
  const options = {
    cwd: f.repository,
    env: { PATH: process.env.PATH, CARGO_DIST_BIN: dist, BUILD_TRACE: trace },
    encoding: "utf8",
    timeout: 15000,
  };
  const script = join(f.repository, "scripts/build-release-local.mjs");
  const strict = spawnSync(
    process.execPath,
    [script, "--verification-receipt"],
    options,
  );
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /clean committed source/);
  await assert.rejects(stat(trace), { code: "ENOENT" });
  const normal = spawnSync(process.execPath, [script, "--all-linux"], options);
  assert.equal(normal.status, 1);
  assert.match(normal.stderr, /failed \(17\)/);
  assert.deepEqual((await readFile(trace, "utf8")).trim().split("\n"), [
    "check",
    "runner",
    "dist",
  ]);
  await assert.rejects(stat(join(f.directory, receiptFilename)), {
    code: "ENOENT",
  });
});

for (const overrides of [
  { version: "0.0.9" },
  { cpu: ["arm64"] },
  { name: "wrong-package" },
  { scripts: { preinstall: "false" } },
]) {
  test(`producer rejects platform metadata ${JSON.stringify(overrides)}`, async (t) => {
    await assert.rejects(
      receipt(await fixture(t, { overrides })),
      /metadata mismatch/,
    );
  });
}

test("strict platform reader rejects traversal, duplicates, links, PAX and corrupt framing", () => {
  const base = platformEntries(native);
  assert.equal(readPlatformArchive(tarball(base)).size, 6);
  for (const extra of [
    ["../outside", "x"],
    ["/outside", "x"],
    ["package/bin/agent-connect", "duplicate"],
    ["package/link", "", "2"],
    ["package/hardlink", "", "1"],
    ["package/pax", "path=../outside", "x"],
  ])
    assert.throws(() => readPlatformArchive(tarball([...base, extra])));
  assert.throws(
    () =>
      readPlatformArchive(
        tarball(base, (tar) => {
          tar[0] ^= 1;
        }),
      ),
    /checksum/,
  );
  assert.throws(
    () =>
      readPlatformArchive(
        tarball(base, (tar) => {
          tar[512 + base[0][1].length] = 1;
        }),
      ),
    /padding/,
  );
  assert.throws(
    () =>
      readPlatformArchive(
        tarball(base, (tar) => {
          tar[tar.length - 1] = 1;
        }),
      ),
    /end marker/,
  );
  assert.throws(
    () => readPlatformArchive(tarball(base.slice(1))),
    /Incomplete/,
  );
  assert.throws(
    () =>
      readPlatformArchive(
        tarball(
          base.map(([name, value], index) => [
            name,
            value,
            index === 0 ? "2" : "0",
          ]),
        ),
      ),
    /non-regular/,
  );
});

test("producer rejects wrong internal hashes even when the outer artifact hash matches", async (t) => {
  const f = await fixture(t, {
    mutateEntries: (entries) =>
      entries.map(([name, value]) => [
        name,
        name === "package/SHA256SUMS"
          ? String(value).replace(/^[a-f0-9]{64}/, "0".repeat(64))
          : value,
      ]),
  });
  await assert.rejects(receipt(f), /Internal artifact checksums/);
});

test("tar numbers and magic reject masked high bits and bytes after numeric terminators", () => {
  const base = platformEntries(native);
  const reseal = (tar) => {
    tar.fill(32, 148, 156);
    const checksum = [...tar.subarray(0, 512)].reduce(
      (sum, byte) => sum + byte,
      0,
    );
    tar.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  };
  for (const mutate of [
    (tar) => {
      tar[124] |= 0x80;
      reseal(tar);
    },
    (tar) => {
      tar.fill(0, 124, 136);
      tar.write(base[0][1].length.toString(8), 124, "ascii");
      tar[135] = 120;
      reseal(tar);
    },
    (tar) => {
      tar[155] = 120;
    },
    (tar) => {
      tar[257] |= 0x80;
      reseal(tar);
    },
  ])
    assert.throws(
      () => readPlatformArchive(tarball(base, mutate)),
      /numeric field|tar format/,
    );
});

test("host gateway and Docker runner are selected independently", async (t) => {
  const f = await fixture(t, { targets: [native, arm] });
  await receipt(f);
  const prepared = await prepareReleaseArtifacts(f);
  const calls = [];
  const selected = await extractVerificationBinaries({
    prepared,
    work: f.work,
    architecture: "aarch64",
    platform: "linux",
    arch: "x64",
    run: async (binary, args) => {
      calls.push([binary, args]);
      return JSON.stringify({ version });
    },
  });
  assert.equal(await readFile(selected.gateway, "utf8"), `gateway:${native}`);
  assert.equal(await readFile(selected.runner, "utf8"), "runner:linux:arm64");
  assert.equal(selected.arch, "arm64");
  assert.equal((await stat(selected.runner)).mode & 0o777, 0o755);
  assert.deepEqual(calls, [[selected.gateway, ["release-info"]]]);
});

test("missing Docker target and false executable version never substitute a host runner", async (t) => {
  const f = await fixture(t);
  await receipt(f);
  const prepared = await prepareReleaseArtifacts(f);
  await assert.rejects(
    extractVerificationBinaries({
      prepared,
      work: f.work,
      architecture: "arm64",
      platform: "linux",
      arch: "x64",
      run: () => {
        throw Error("must not execute");
      },
    }),
    /Missing Docker Linux runner/,
  );
  await assert.rejects(
    extractVerificationBinaries({
      prepared,
      work: f.work,
      architecture: "amd64",
      platform: "linux",
      arch: "x64",
      run: async () => JSON.stringify({ version: "0.0.9" }),
    }),
    /release-info version/,
  );
});

for (const failure of [
  undefined,
  "step failure",
  "dirty during step",
  "dirty after final step",
  "commit during step",
]) {
  test(`reuse runs every requested gate with no builds and cleans after ${failure ?? "success"}`, async (t) => {
    const f = await fixture(t, { targets: [native, arm] });
    await receipt(f);
    await write(
      join(f.repository, "target/debug/agent-connect"),
      "stale debug must not run",
    );
    const calls = [];
    let work;
    let selected;
    let cleaned = false;
    const run = async (binary, args, options) => {
      calls.push([binary, args]);
      if (args[0] === "release-info") {
        selected = binary;
        return JSON.stringify({ version });
      }
      if (binary === engine) {
        work = dirname(options.env.DOCKER_CONFIG);
        if (args[0] === "info") return "arm64\n";
        if (args[0] === "build") {
          assert.equal(
            await readFile(join(args.at(-1), "session-runner"), "utf8"),
            "runner:linux:arm64",
          );
          return "";
        }
        if (args[1] === "ls") return options.env.ACP_BOX_IMAGE;
        if (args[1] === "rm") {
          cleaned = true;
          return "";
        }
        // Rootless Podman copies the box once per id mapping before the gates.
        if (args[0] === "run") return "";
      }
      if (binary === "npm") {
        assert.equal(options.env.ACP_GATEWAY_MODE, "release-artifacts");
        assert.equal(options.env.ACP_GATEWAY_BIN, selected);
        assert.ok(options.env.AGENT_CONNECT_RELEASE_DIR.startsWith(work));
        assert.equal(
          await readFile(
            join(options.env.AGENT_CONNECT_RELEASE_DIR, "acp-chat-sample.tgz"),
            "utf8",
          ),
          "packed sample fixture",
        );
        if (failure === "step failure") throw Error("fixture step failure");
        if (failure === "dirty during step")
          await writeFile(join(f.repository, "untracked-change"), "changed");
        if (failure === "dirty after final step" && args[1] === steps.at(-1))
          await writeFile(join(f.repository, "untracked-change"), "changed");
        if (failure === "commit during step")
          git(f.repository, [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "changed",
          ]);
        return "";
      }
      throw Error(`Unexpected build/command: ${binary}`);
    };
    const action = verify({
      repository: f.repository,
      releaseArtifacts: f.directory,
      run,
      hostPlatform: "linux",
      hostArch: "x64",
    });
    if (failure) await assert.rejects(action);
    else await action;
    assert.ok(cleaned);
    await assert.rejects(stat(work), { code: "ENOENT" });
    assert.ok(
      calls.every(
        ([binary]) =>
          binary !== "cargo" &&
          !binary.includes("build-local.sh") &&
          !binary.includes("target/debug"),
      ),
    );
    if (!failure)
      assert.deepEqual(
        calls.filter(([binary]) => binary === "npm").map(([, args]) => args[1]),
        steps,
      );
  });
}

test("reuse cleans its owned extraction directory when the Docker payload is absent", async (t) => {
  const f = await fixture(t);
  await receipt(f);
  let work;
  const run = async (binary, args, options) => {
    assert.equal(binary, engine);
    assert.equal(args[0], "info");
    work = dirname(options.env.DOCKER_CONFIG);
    return "aarch64\n";
  };
  await assert.rejects(
    verify({
      repository: f.repository,
      releaseArtifacts: f.directory,
      run,
      hostPlatform: "linux",
      hostArch: "x64",
    }),
    /Missing Docker Linux runner/,
  );
  await assert.rejects(stat(work), { code: "ENOENT" });
});

test("gate resolver refuses invalid supplied mode/path without source build or stale fallback", async (t) => {
  const f = await fixture(t);
  const stale = join(f.repository, "target/debug/agent-connect");
  await write(stale, "stale");
  let builds = 0;
  for (const env of [
    { ACP_GATEWAY_MODE: "wrong" },
    { ACP_GATEWAY_MODE: "release-artifacts" },
    { ACP_GATEWAY_BIN: "relative" },
    { ACP_GATEWAY_BIN: join(f.root, "missing") },
    { ACP_GATEWAY_BIN: f.root },
  ])
    await assert.rejects(
      gatewayTestBinary({
        repository: f.repository,
        env,
        build: () => builds++,
      }),
    );
  assert.equal(builds, 0);
  const binary = join(f.root, "verified");
  await writeFile(binary, "fixture", { mode: 0o700 });
  assert.equal(
    await gatewayTestBinary({
      repository: f.repository,
      env: { ACP_GATEWAY_MODE: "release-artifacts", ACP_GATEWAY_BIN: binary },
      build: () => builds++,
    }),
    binary,
  );
  assert.equal(builds, 0);
  assert.equal(
    await gatewayTestBinary({
      repository: f.repository,
      env: {},
      build: () => builds++,
    }),
    stale,
  );
  assert.equal(builds, 1);
  await chmod(binary, 0o600);
  await assert.rejects(
    gatewayTestBinary({
      repository: f.repository,
      env: { ACP_GATEWAY_BIN: binary },
    }),
  );
});

for (const consumer of [
  "owner-ui.mjs",
  "gateway-scenarios.mjs",
  "gateway-cli.test.mjs",
  "gateway-teardown.mjs",
]) {
  test(`${consumer} fails invalid explicit selection before launching a fixture`, async () => {
    const path = join(import.meta.dirname, consumer);
    const text = await readFile(path, "utf8");
    assert.ok(text.includes("gatewayTestBinary"));
    assert.ok(!text.includes("target/debug/agent-connect"));
    if (consumer === "gateway-cli.test.mjs")
      assert.match(text, /const canonical = binary;/);
    const result = spawnSync(process.execPath, [path], {
      env: {
        PATH: "/nonexistent",
        ACP_BOX_IMAGE: "agent-connect-box-test:fixture",
        ACP_GATEWAY_MODE: "bad-mode",
        ACP_GATEWAY_BIN: "/nonexistent/gateway",
      },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid ACP_GATEWAY_MODE/);
    assert.doesNotMatch(result.stderr, /spawn.*cargo|ENOENT.*cargo/);
  });
}
