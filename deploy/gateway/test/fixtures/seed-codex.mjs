import assert from "node:assert/strict";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

// Only fixture-owned dedicated homes may receive this test provider config.
export async function seedCodexMock(home, root) {
  const ownedRoot = await realpath(root);
  const target = await realpath(home);
  const within = relative(ownedRoot, target);
  assert.ok(
    within &&
      within !== ".." &&
      !within.startsWith("../") &&
      !isAbsolute(within),
    "Mock home must be inside the disposable test root",
  );
  const metadata = await lstat(home);
  assert.ok(
    metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      metadata.uid === process.getuid() &&
      (metadata.mode & 0o077) === 0,
    "Mock home must be a private owned directory",
  );
  const codex = join(home, "codex-home");
  await mkdir(codex, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const child = await lstat(codex);
  assert.ok(
    child.isDirectory() &&
      !child.isSymbolicLink() &&
      child.uid === process.getuid() &&
      (child.mode & 0o077) === 0,
    "Mock Codex directory must be private and owned",
  );
  await writeFile(
    join(codex, "config.toml"),
    await readFile(new URL("./codex-config.toml", import.meta.url)),
    { mode: 0o600, flag: "wx" },
  );
}
