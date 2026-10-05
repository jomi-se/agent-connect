import assert from "node:assert/strict";
import { test } from "node:test";
import { testBoxImage, removeTestImages } from "./test-box-images.mjs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

async function executable(path, code) {
  await writeFile(path, `#!${process.execPath}\n${code}`, { mode: 0o700 });
}

test("test tags reject namespace and Docker argument injection", () => {
  assert.equal(
    testBoxImage("0.0.1", "run1"),
    "agent-connect-box-test:0.0.1-run1",
  );
  for (const run of ["bad/tag", "bad:tag", "bad tag", "x".repeat(128)])
    assert.throws(() => testBoxImage("0.0.1", run));
});

test("cleanup removes this run's base and layers by tag, preserving shared IDs and other runs", async () => {
  const base = testBoxImage("0.0.1", "run1");
  const layer = `${base}-0123456789abcdef`;
  const images = new Map([
    [base, "same-image-id"],
    [layer, "layer-id"],
    ["agent-connect-box:0.0.1", "same-image-id"],
    ["agent-connect-session:0.0.1", "same-image-id"],
    [testBoxImage("0.0.1", "run2"), "same-image-id"],
    [`${base}-another-run`, "other-id"],
  ]);
  await removeTestImages(base, async (args) => {
    if (args[1] === "ls") return [...images.keys()].join("\n");
    assert.deepEqual(args.slice(0, 2), ["image", "rm"]);
    assert.ok(images.delete(args[2]));
    return "";
  });
  assert.deepEqual(
    [...images.keys()],
    [
      "agent-connect-box:0.0.1",
      "agent-connect-session:0.0.1",
      testBoxImage("0.0.1", "run2"),
      `${base}-another-run`,
    ],
  );
});

test("failed cleanup still attempts every built tag and reports failure", async () => {
  const base = testBoxImage("0.0.1", "run3");
  const layer = `${base}-abcdef0123456789`;
  const attempted = [];
  await assert.rejects(
    removeTestImages(base, async (args) => {
      if (args[1] === "ls") return `${base}\n${layer}\n`;
      attempted.push(args[2]);
      if (args[2] === base) throw new Error("image in use");
      return "";
    }),
    AggregateError,
  );
  assert.deepEqual(attempted, [base, layer]);
});

test("cleanup refuses installed gateway tags before calling Docker", async () => {
  for (const base of ["agent-connect-box:0.0.1", "agent-connect-session:0.0.1"])
    await assert.rejects(
      removeTestImages(base, () => assert.fail("Docker must not be called")),
      /isolated test namespace/,
    );
});

test("packed setup refuses an old binary before applying or building an installed image", async () => {
  const root = await mkdtemp(join(tmpdir(), "test-box-preflight-"));
  try {
    const bin = join(root, "bin");
    const trace = join(root, "calls.jsonl");
    await mkdir(bin);
    await writeFile(join(root, "release.json"), '{"version":"0.0.1"}');
    const record = `import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv.slice(2))+'\\n');`;
    const gateway = `${record}
      if (process.argv[2] === 'setup') console.log(JSON.stringify({boxImage:'agent-connect-box:0.0.1'}));`;
    await executable(
      join(bin, "npm"),
      `import { mkdirSync, writeFileSync } from 'node:fs';
       mkdirSync('node_modules/.bin', {recursive:true});
       writeFileSync('node_modules/.bin/agent-connect', ${JSON.stringify(`#!${process.execPath}\n${gateway}`)}, {mode:0o700});`,
    );
    await executable(join(bin, "docker"), record);
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "test-box-setup.mjs"), root],
      { env: { PATH: bin }, encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must support isolated test box builds/);
    const calls = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(calls.some((args) => args[0] === "setup"));
    assert.ok(
      calls.every((args) => !args.includes("--apply") && args[0] !== "build"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clean-room failure cleans built box, layer and driver tags without touching installed images", async () => {
  const root = await mkdtemp(join(tmpdir(), "test-clean-room-images-"));
  try {
    const bin = join(root, "bin");
    const state = join(root, "images.json");
    const trace = join(root, "calls.jsonl");
    await mkdir(bin);
    await writeFile(
      join(root, "release.json"),
      '{"version":"0.0.1","artifacts":{}}',
    );
    await writeFile(join(root, "acp-chat-sample.tgz"), "");
    await writeFile(state, JSON.stringify(["agent-connect-box:0.0.1"]));
    await executable(
      join(bin, "docker"),
      `import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
       const args=process.argv.slice(2), file=${JSON.stringify(state)};
       const images=JSON.parse(readFileSync(file));
       appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args)+'\\n');
       if (args[0]==='build') images.push(args[args.indexOf('-t')+1]);
       if (args[0]==='image' && args[1]==='inspect') console.log('sha256:'+'a'.repeat(64));
       if (args[0]==='run') {
         if (args.includes('--name')) {
           const base=args.find(a=>a.startsWith('AGENT_CONNECT_TEST_BOX_IMAGE=')).split('=')[1];
           images.push(base, base+'-0123456789abcdef');
           process.exitCode=1;
           console.error('intentional driver failure after box build');
         } else console.log('1000');
       }
       if (args[0]==='image' && args[1]==='ls') console.log(images.join('\\n'));
       if (args[0]==='image' && args[1]==='rm') images.splice(images.indexOf(args[2]),1);
       writeFileSync(file,JSON.stringify(images));`,
    );
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "clean-room.mjs"), root],
      { env: { PATH: bin }, encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /intentional driver failure/);
    assert.deepEqual(JSON.parse(await readFile(state, "utf8")), [
      "agent-connect-box:0.0.1",
    ]);
    const calls = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(
      calls.filter((args) => args[0] === "image" && args[1] === "rm").length,
      3,
    );
    const diagnostics = result.stdout.match(
      /ACP clean-room diagnostics: (.*)\/work\/report.json/,
    );
    assert.ok(diagnostics);
    await rm(diagnostics[1], { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
