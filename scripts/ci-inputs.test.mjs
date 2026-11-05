import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize as normalizePath, relative } from "node:path";
import { excluded, inputsHash, jobs } from "./ci-inputs.mjs";

function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), "ci-inputs-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const manifest = (version, other = "0.0.6") =>
    JSON.stringify({
      name: "x",
      version,
      dependencies: { other, "@open-agent-connect/web": `^${version}` },
    });
  write("packages/gateway-npm/package.json", manifest("0.0.5"));
  write("packages/web-sdk/package.json", manifest("0.1.0"));
  write("crates/gateway/src/lib.rs", "fn main() {}\n");
  write("crates/gateway/Cargo.toml", 'name = "gw"\nversion = "0.0.5"\n');
  write(
    "Cargo.lock",
    'version = 4\n\n[[package]]\nname = "gw"\nversion = "0.0.5"\n\n[[package]]\nname = "dep"\nversion = "0.0.6"\n',
  );
  write("deploy/test/fixture/package.json", "{ not json");
  write("docs/guide.md", "# guide\n");
  write("README.md", "# readme\n");
  write("deploy/gateway/box/entrypoint.sh", "#!/bin/sh\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  return { repo, write, manifest };
}

test("excluded paths are prefixes, exact names or suffixes", () => {
  assert.ok(excluded("docs/a/b.md", ["docs/"]));
  assert.ok(!excluded("docsy/a", ["docs/"]));
  assert.ok(excluded("Cargo.lock", ["Cargo.lock"]));
  assert.ok(!excluded("crates/x/Cargo.lock", ["Cargo.lock"]));
  assert.ok(excluded("crates/gateway/README.md", ["*.md"]));
});

test("keep overrides an exclusion", () => {
  assert.ok(!excluded("deploy/a.sh", ["deploy/"], ["deploy/a.sh"]));
  assert.ok(excluded("deploy/b.sh", ["deploy/"], ["deploy/a.sh"]));
});

test("every file Rust compiles in is a Rust input", () => {
  const repo = join(import.meta.dirname, "..");
  const sources = execFileSync("git", ["ls-files", "crates/*.rs"], {
    cwd: repo,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  for (const source of sources)
    for (const [, target] of readFileSync(join(repo, source), "utf8").matchAll(
      /include_(?:str|bytes)!\(\s*"([^"]+)"/g,
    )) {
      const path = relative(
        repo,
        normalizePath(join(repo, dirname(source), target)),
      );
      assert.ok(
        !excluded(path, jobs.rust.exclude, jobs.rust.keep),
        `${source} compiles in ${path}; add it to jobs.rust.keep`,
      );
    }
});

test("an excluded change reuses, an included one runs", (t) => {
  const { repo, write } = fixture(t);
  const before = Object.fromEntries(
    Object.keys(jobs).map((job) => [job, inputsHash(job, repo)]),
  );
  write("docs/guide.md", "# changed\n");
  for (const job of Object.keys(jobs))
    assert.equal(
      inputsHash(job, repo),
      before[job],
      `docs change reran ${job}`,
    );
  write("crates/gateway/src/lib.rs", "fn main() { }\n");
  assert.notEqual(inputsHash("rust", repo), before.rust);
  assert.notEqual(inputsHash("gateway", repo), before.gateway);
  assert.equal(inputsHash("web", repo), before.web);
});

test("a new file nobody listed makes every job run", (t) => {
  const { repo, write } = fixture(t);
  const before = Object.keys(jobs).map((job) => inputsHash(job, repo));
  write("tools/new-thing.sh", "echo\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  assert.deepEqual(
    Object.keys(jobs).map((job) => inputsHash(job, repo) === before.shift()),
    [false, false, false],
  );
});

test("a version bump reuses, a dependency change does not", (t) => {
  const { repo, write, manifest } = fixture(t);
  const before = inputsHash("gateway", repo);
  // Ours moves to 0.0.6 while a third-party dependency already sits at
  // 0.0.6: only ours is normalized.
  write("packages/gateway-npm/package.json", manifest("0.0.6"));
  write("crates/gateway/Cargo.toml", 'name = "gw"\nversion = "0.0.6"\n');
  write(
    "Cargo.lock",
    'version = 4\n\n[[package]]\nname = "gw"\nversion = "0.0.6"\n\n[[package]]\nname = "dep"\nversion = "0.0.6"\n',
  );
  assert.equal(inputsHash("gateway", repo), before);
  write("packages/gateway-npm/package.json", manifest("0.0.6", "0.0.7"));
  assert.notEqual(inputsHash("gateway", repo), before, "dependency change");
});

test("an executable bit is an input", (t) => {
  const { repo } = fixture(t);
  const before = inputsHash("gateway", repo);
  execFileSync("chmod", ["+x", join(repo, "deploy/gateway/box/entrypoint.sh")]);
  assert.notEqual(inputsHash("gateway", repo), before);
});
