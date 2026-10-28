import assert from "node:assert/strict";
import { test } from "node:test";
import { publishPackage } from "./release-publish.mjs";
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
  for (const script of [
    "release.mjs",
    "release-info.mjs",
    "release-publish.mjs",
  ])
    await writeFile(
      join(directory, "scripts", script),
      await readFile(new URL(script, import.meta.url)),
    );
  const manifest = async (file, value) =>
    writeFile(join(directory, file), JSON.stringify(value));
  await manifest("packages/web-sdk/package.json", { version: "0.0.10" });
  await manifest("packages/gateway-npm/package.json", { version: "0.0.1" });
  await manifest("deploy/gateway/box/package.json", { version: "0.0.1" });
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
  await manifest("deploy/gateway/box/package.json", { version: "0.0.2" });
  const boxDrift = check();
  assert.notEqual(boxDrift.status, 0);
  assert.match(boxDrift.stderr, /must share one version/);
  await manifest("deploy/gateway/box/package.json", { version: "0.0.1" });
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

const publishInput = {
  name: "@open-agent-connect/gateway-linux-x64",
  version: "0.0.2",
  path: "/fixture/package.tgz",
  cwd: "/fixture",
  env: { HOME: "/fixture/home" },
};
const npmReply = (value, status = 0) => ({
  status,
  signal: null,
  stdout: JSON.stringify(value),
  stderr: "",
});
function publicationFixture(replies) {
  let elapsed = 0;
  const calls = [];
  const logs = [];
  const dependencies = {
    run(binary, args, options) {
      assert.equal(binary, "npm");
      assert.ok(args.includes("--fetch-retries=0"));
      calls.push({ args, options });
      assert.ok(
        replies.length,
        "Unexpected npm call; no real npm is available",
      );
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    },
    log: (message) => logs.push(message),
    now: () => elapsed,
    sleep: async (milliseconds) => {
      elapsed += milliseconds;
    },
    confirmationMs: 25,
    lookupMs: 10,
    pollMs: 10,
    publishMs: 100,
  };
  return { calls, logs, dependencies, elapsed: () => elapsed };
}

test("publication streams npm output and confirms delayed registry visibility without republishing", async () => {
  const fixture = publicationFixture([
    npmReply(["0.0.1"]),
    npmReply(null),
    npmReply({ error: { code: "E404" } }, 1),
    npmReply("0.0.2"),
  ]);
  await publishPackage(publishInput, fixture.dependencies);
  assert.deepEqual(
    fixture.calls.map(({ args }) => args[0]),
    ["view", "publish", "view", "view"],
  );
  const [listed, published, firstConfirmation] = fixture.calls;
  assert.deepEqual(listed.args.slice(0, 4), [
    "view",
    publishInput.name,
    "versions",
    "--json",
  ]);
  assert.deepEqual(published.options.stdio, ["ignore", "inherit", "inherit"]);
  assert.equal(published.options.timeout, 100);
  assert.equal(published.options.killSignal, "SIGKILL");
  assert.equal(published.options.env, publishInput.env);
  for (const flag of [
    "--access",
    "public",
    "--tag",
    "latest",
    "--ignore-scripts",
    "--provenance",
  ])
    assert.ok(published.args.includes(flag));
  assert.deepEqual(firstConfirmation.args.slice(0, 4), [
    "view",
    `${publishInput.name}@0.0.2`,
    "version",
    "--json",
  ]);
  assert.match(fixture.logs[0], /^Publishing .*@0.0.2$/);
  assert.match(fixture.logs.at(-1), /@0.0.2 is live in the registry$/);
});

for (const versions of ["0.0.2", ["0.0.1", "0.0.2"]]) {
  test(`publication skips exact existing version from ${typeof versions} listing`, async () => {
    const fixture = publicationFixture([npmReply(versions)]);
    await publishPackage(publishInput, fixture.dependencies);
    assert.equal(fixture.calls.length, 1);
    assert.match(
      fixture.logs[0],
      /already published \(confirmed in registry\)/,
    );
  });
}

for (const [label, reply] of [
  [
    "package not found or inaccessible",
    npmReply({ error: { code: "E404" } }, 1),
  ],
  [
    "untrusted missing-version diagnostic",
    npmReply(
      { error: { code: "E404", summary: "No match found for version 0.0.2" } },
      1,
    ),
  ],
  ["authentication failure", npmReply({ error: { code: "E401" } }, 1)],
  ["network failure", npmReply({ error: { code: "ECONNRESET" } }, 1)],
  ["nonzero despite apparent versions", npmReply(["0.0.1"], 1)],
  ["invalid JSON", { status: 0, stdout: "not json" }],
  ["invalid list member", npmReply(["0.0.1", null])],
  ["invalid version text", npmReply(["untrusted"])],
  ["invalid prerelease version", npmReply(["0.0.1-."])],
  ["invalid object", npmReply({ versions: ["0.0.1"] })],
  ["missing stdout", { status: 0, stdout: null }],
  ["spawn failure", { status: null, stdout: null, error: { code: "ENOENT" } }],
  [
    "lookup timeout",
    { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" } },
  ],
]) {
  test(`publication refuses ${label} before any write`, async () => {
    const fixture = publicationFixture([reply]);
    await assert.rejects(publishPackage(publishInput, fixture.dependencies));
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].args[0], "view");
  });
}

test("publication missing package gives a bootstrap instruction without publishing", async () => {
  const fixture = publicationFixture([
    npmReply({ error: { code: "E404" } }, 1),
  ]);
  await assert.rejects(
    publishPackage(publishInput, fixture.dependencies),
    /separately reviewed bootstrap/,
  );
});

for (const reply of [
  npmReply(null, 1),
  { status: null, signal: "SIGTERM" },
  { status: null, error: { code: "ETIMEDOUT" } },
  { status: null, error: { code: "ENOENT" } },
  new Error("synthetic runner failure"),
]) {
  test("publication failure is uncertain and never retried", async () => {
    const fixture = publicationFixture([npmReply(["0.0.1"]), reply]);
    await assert.rejects(
      publishPackage(publishInput, fixture.dependencies),
      /outcome .* is uncertain; publication was not retried/,
    );
    assert.deepEqual(
      fixture.calls.map(({ args }) => args[0]),
      ["view", "publish"],
    );
  });
}

test("publication visibility deadline bounds read-only polling and reports unconfirmed success", async () => {
  const absent = npmReply({ error: { code: "E404" } }, 1);
  const fixture = publicationFixture([
    npmReply(["0.0.1"]),
    npmReply(null),
    absent,
    absent,
    absent,
  ]);
  await assert.rejects(
    publishPackage(publishInput, fixture.dependencies),
    /reported publish success.*visibility is unconfirmed.*not retried/,
  );
  assert.equal(
    fixture.calls.filter(({ args }) => args[0] === "publish").length,
    1,
  );
  assert.equal(fixture.elapsed(), 25);
  assert.deepEqual(
    fixture.calls.slice(2).map(({ options }) => options.timeout),
    [10, 10, 5],
  );
  assert.ok(!fixture.logs.some((line) => line.includes("is live")));
});

for (const reply of [
  npmReply("0.0.1"),
  npmReply(["0.0.2"]),
  npmReply({ error: { code: "E403" } }, 1),
  { status: 0, stdout: "broken" },
]) {
  test("publication cannot claim visibility from a wrong or failed confirmation", async () => {
    const fixture = publicationFixture([
      npmReply(["0.0.1"]),
      npmReply(null),
      reply,
    ]);
    await assert.rejects(
      publishPackage(publishInput, fixture.dependencies),
      /visibility is unconfirmed/,
    );
    assert.equal(
      fixture.calls.filter(({ args }) => args[0] === "publish").length,
      1,
    );
    assert.ok(!fixture.logs.some((line) => line.includes("is live")));
  });
}

test("publication dry-run exposes output but never polls for a new version", async () => {
  const fixture = publicationFixture([npmReply(["0.0.1"]), npmReply(null)]);
  await publishPackage({ ...publishInput, dryRun: true }, fixture.dependencies);
  assert.deepEqual(
    fixture.calls.map(({ args }) => args[0]),
    ["view", "publish"],
  );
  assert.ok(fixture.calls[1].args.includes("--dry-run"));
  assert.ok(!fixture.calls[1].args.includes("--provenance"));
  assert.match(fixture.logs.at(-1), /no publication was requested/);
});

async function publicationRepository(t) {
  const directory = await mkdtemp(join(tmpdir(), "release-publication-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const folder of [
    "scripts",
    "bin",
    "home",
    "release",
    "packages/web-sdk",
    "packages/gateway-npm",
    "deploy/gateway/box",
    "examples/acp-chat",
    "crates/gateway",
  ])
    await mkdir(join(directory, folder), { recursive: true });
  for (const script of [
    "release.mjs",
    "release-info.mjs",
    "release-publish.mjs",
  ])
    await writeFile(
      join(directory, "scripts", script),
      await readFile(new URL(script, import.meta.url)),
    );
  for (const path of [
    "packages/web-sdk",
    "packages/gateway-npm",
    "deploy/gateway/box",
    "examples/acp-chat",
  ])
    await writeFile(
      join(directory, path, "package.json"),
      JSON.stringify({ version }),
    );
  await writeFile(
    join(directory, "crates/gateway/Cargo.toml"),
    `[package]\nversion = "${version}"\n`,
  );
  const artifacts = {};
  const filenames = [
    "gateway",
    "gateway-linux-x64",
    "gateway-darwin-arm64",
    "gateway-linux-arm64",
  ].map((name) => `open-agent-connect-${name}-${version}.tgz`);
  for (const filename of filenames) {
    const bytes = Buffer.from(`synthetic artifact ${filename}`);
    await writeFile(join(directory, "release", filename), bytes);
    artifacts[filename] = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  const metadata = {
    version,
    sdkVersion: version,
    localOnly: false,
    artifacts,
  };
  const metadataPath = join(directory, "release/release.json");
  await writeFile(metadataPath, JSON.stringify(metadata));
  const npm = join(directory, "bin/npm");
  // No PATH fallback: this executable only records/responds and never delegates.
  await writeFile(
    npm,
    `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { basename, join } = require('node:path');
const args = process.argv.slice(2);
const log = join(process.cwd(), 'npm-calls.jsonl');
appendFileSync(log, JSON.stringify(args) + '\\n');
const statePath = join(process.cwd(), 'published.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
if (args[0] === 'view' && args[2] === 'versions') {
  console.log(JSON.stringify(process.env.FIXTURE_PREEXISTING ? [${JSON.stringify(version)}] : ['0.0.0']));
} else if (args[0] === 'publish') {
  console.log('fake npm publish stdout');
  console.error('fake npm publish stderr');
  if (!args.includes('--dry-run')) {
    const name = '@open-agent-connect/' + basename(args[1]).slice('open-agent-connect-'.length, -${JSON.stringify(`-${version}.tgz`)}.length);
    state[name] = true;
    writeFileSync(statePath, JSON.stringify(state));
  }
} else if (args[0] === 'view' && args[2] === 'version' && state[args[1].slice(0, -${JSON.stringify(`@${version}`)}.length)]) {
  console.log(JSON.stringify(process.env.FIXTURE_BAD_CONFIRMATION ? '0.0.0' : ${JSON.stringify(version)}));
} else {
  console.error('Unexpected fake npm operation');
  process.exitCode = 99;
}
`,
    { mode: 0o700 },
  );
  const env = {
    PATH: join(directory, "bin"),
    HOME: join(directory, "home"),
    npm_config_cache: join(directory, "cache"),
    GITHUB_ACTIONS: "true",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.invalid",
    AGENT_CONNECT_PUBLISH_APPROVED: version,
  };
  return {
    directory,
    metadata,
    metadataPath,
    filenames,
    run(command = "publish", overrides = {}) {
      return spawnSync(
        process.execPath,
        [
          join(directory, "scripts/release.mjs"),
          command,
          "--directory",
          "release",
        ],
        {
          env: { ...env, ...overrides },
          encoding: "utf8",
          timeout: 10000,
        },
      );
    },
    async calls() {
      return (
        await readFile(join(directory, "npm-calls.jsonl"), "utf8").catch(
          (error) => {
            if (error.code === "ENOENT") return "";
            throw error;
          },
        )
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

test("publication CLI keeps platform-first order and streams both fake npm outputs", async (t) => {
  const fixture = await publicationRepository(t);
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fake npm publish stdout/);
  assert.match(result.stderr, /fake npm publish stderr/);
  const calls = await fixture.calls();
  assert.deepEqual(
    calls.map((args) => args[0]),
    Array.from({ length: 4 }, () => ["view", "publish", "view"]).flat(),
  );
  const publishes = calls.filter((args) => args[0] === "publish");
  assert.deepEqual(
    publishes.map((args) => args[1].split("/").at(-1)),
    [...fixture.filenames.slice(1), fixture.filenames[0]],
  );
  assert.equal(
    (result.stdout.match(/is live in the registry/g) ?? []).length,
    4,
  );
});

for (const overrides of [
  { GITHUB_ACTIONS: "false" },
  { ACTIONS_ID_TOKEN_REQUEST_URL: "" },
  { AGENT_CONNECT_PUBLISH_APPROVED: "wrong" },
]) {
  test("publication CLI approval guards stop before invoking fake npm", async (t) => {
    const fixture = await publicationRepository(t);
    const result = fixture.run("publish", overrides);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /protected OIDC workflow/);
    assert.deepEqual(await fixture.calls(), []);
  });
}

test("publication CLI refuses local-only metadata and checksum tampering before npm", async (t) => {
  const fixture = await publicationRepository(t);
  await writeFile(
    fixture.metadataPath,
    JSON.stringify({ ...fixture.metadata, localOnly: true }),
  );
  assert.notEqual(fixture.run().status, 0);
  assert.deepEqual(await fixture.calls(), []);
  await writeFile(fixture.metadataPath, JSON.stringify(fixture.metadata));
  for (const filename of fixture.filenames)
    await writeFile(join(fixture.directory, "release", filename), "tampered");
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Artifact checksum mismatch/);
  assert.deepEqual(await fixture.calls(), []);
});

test("publication CLI stops before the next package after unconfirmed visibility", async (t) => {
  const fixture = await publicationRepository(t);
  const result = fixture.run("publish", { FIXTURE_BAD_CONFIRMATION: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /visibility is unconfirmed/);
  assert.deepEqual(
    (await fixture.calls()).map((args) => args[0]),
    ["view", "publish", "view"],
  );
});

test("publication CLI dry-run never performs registry confirmation", async (t) => {
  const fixture = await publicationRepository(t);
  const result = fixture.run("publish-dry-run", {
    GITHUB_ACTIONS: "false",
    ACTIONS_ID_TOKEN_REQUEST_URL: "",
    AGENT_CONNECT_PUBLISH_APPROVED: "",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    (await fixture.calls()).map((args) => args[0]),
    Array.from({ length: 4 }, () => ["view", "publish"]).flat(),
  );
  assert.ok(
    (await fixture.calls())
      .filter((args) => args[0] === "publish")
      .every((args) => args.includes("--dry-run")),
  );
});
