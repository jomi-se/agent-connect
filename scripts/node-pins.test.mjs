import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nodePinProblems } from "./node-pins.mjs";

const workflow = (setup) => `jobs:
  build:
    steps:
      - uses: actions/checkout@0000000000000000000000000000000000000000 # v6
      - uses: actions/setup-node@0000000000000000000000000000000000000000 # v6
        with:
${setup}
`;

function fixture(t, overrides = {}) {
  const repo = mkdtempSync(join(tmpdir(), "node-pins-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const manifest = (engines) => JSON.stringify({ engines: { node: engines } });
  const files = {
    ".node-version": "26.13.0\n",
    "package.json": manifest(">=26.13 <27"),
    "examples/acp-chat/package.json": manifest(">=26.13 <27"),
    "package-lock.json": JSON.stringify({
      packages: { "": { engines: { node: ">=26.13 <27" } } },
    }),
    "packages/gateway-npm/package.json": manifest(">=24.15"),
    "packages/web-sdk/package.json": manifest(">=22"),
    ".github/workflows/ci.yml": workflow(
      "          node-version-file: .node-version",
    ),
    "deploy/box/Dockerfile": "FROM node:26-bookworm-slim@sha256:00 AS base\n",
    "scripts/run.mjs": 'import { readFile } from "node:fs/promises";\n',
    "docs/history.md": "We once ran node:24-bookworm.\n",
    ...overrides,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  return repo;
}

const problems = (t, overrides) => nodePinProblems(fixture(t, overrides));

test("a repository that agrees with .node-version has no problems", (t) => {
  assert.deepEqual(problems(t), []);
});

test("this repository agrees with its .node-version", () => {
  assert.deepEqual(nodePinProblems(resolve(import.meta.dirname, "..")), []);
});

test(".node-version must be one exact version", (t) => {
  assert.match(problems(t, { ".node-version": "26\n" })[0], /exact version/);
});

test("repository engines and the lock root follow .node-version", (t) => {
  const found = problems(t, {
    "examples/acp-chat/package.json": JSON.stringify({
      engines: { node: ">=24.15 <25" },
    }),
    "package-lock.json": JSON.stringify({ packages: { "": {} } }),
  });
  assert.equal(found.length, 2);
  assert.match(found[0], /examples\/acp-chat.*">=26.13 <27"/);
  assert.match(found[1], /package-lock\.json/);
});

test("a published package may not ask for a newer Node than CI's", (t) => {
  const found = problems(t, {
    "packages/web-sdk/package.json": JSON.stringify({
      engines: { node: ">=26.14" },
    }),
  });
  assert.equal(found.length, 1);
  assert.match(found[0], /web-sdk.*newer Node/);
});

test("setup-node reads .node-version instead of naming a version", (t) => {
  const found = problems(t, {
    ".github/workflows/ci.yml": workflow("          node-version: 26.13.0"),
  });
  assert.equal(found.length, 2);
  assert.match(found[0], /ci\.yml:7: use node-version-file/);
  assert.match(found[1], /1 setup-node steps but 0 read/);
});

test("container images use .node-version's major; docs may differ", (t) => {
  const found = problems(t, {
    "deploy/box/Dockerfile": "FROM node:24-bookworm-slim@sha256:00\n",
  });
  assert.deepEqual(found, [
    "deploy/box/Dockerfile:1: image node:24 differs from .node-version 26.13.0",
  ]);
});

test("code may not parse the Node version by hand", (t) => {
  const found = problems(t, {
    "scripts/run.mjs":
      'assert.equal(process.versions.node.split(".")[0], "26");\n',
  });
  assert.equal(found.length, 1);
  assert.match(found[0], /scripts\/run\.mjs:1: parses the Node version/);
});
