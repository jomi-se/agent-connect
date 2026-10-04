// Typecheck the actual README snippets against the built package root API.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const repo = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "agent-connect-readme-"));
try {
  await writeFile(
    join(directory, "package.json"),
    '{"private":true,"type":"module"}',
  );
  await symlink(
    join(repo, "node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  const files = [];
  for (const [index, name] of [
    "README.md",
    "packages/web-sdk/README.md",
  ].entries()) {
    const source = await readFile(join(repo, name), "utf8");
    const snippets = [...source.matchAll(/```(ts|tsx)\n([\s\S]*?)\n```/g)];
    assert.ok(snippets.length, `No TypeScript examples found in ${name}`);
    for (const [part, snippet] of snippets.entries()) {
      const file = `snippet-${index}-${part}.${snippet[1]}`;
      await writeFile(join(directory, file), snippet[2]);
      files.push(file);
    }
  }
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      extends: join(repo, "tsconfig.base.json"),
      compilerOptions: { noEmit: true, jsx: "react-jsx" },
      files,
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      join(repo, "node_modules/typescript/bin/tsc"),
      "-p",
      join(directory, "tsconfig.json"),
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  console.log(
    `Typechecked ${files.length} README snippets against root exports`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
