import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { compatibility, preflightOpenClaw } from "./openclaw-test-runtime.mjs";

preflightOpenClaw();
const prefix = process.argv[2];
if (
  !prefix ||
  !isAbsolute(prefix) ||
  resolve(prefix) === "/" ||
  existsSync(prefix)
) {
  throw new Error(
    "Usage: node scripts/openclaw-install.mjs /absolute/new/dedicated-prefix (must not already exist)",
  );
}
const response = await fetch(compatibility.tarball, {
  signal: AbortSignal.timeout(120000),
});
if (!response.ok)
  throw new Error(`Dependency download failed: HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
if (integrity !== compatibility.integrity)
  throw new Error(
    "Pinned OpenClaw tarball integrity mismatch; installation refused",
  );
// Keep the verified archive beside npm's lockfile so its file dependency remains reusable.
await mkdir(prefix);
const tarball = `${prefix}/openclaw-${compatibility.version}.tgz`;
await writeFile(tarball, archive);
const result = spawnSync(
  "npm",
  ["install", "--prefix", prefix, "--no-audit", "--no-fund", tarball],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0)
  throw new Error(
    `npm install exited ${result.status}; partial install remains at ${prefix}`,
  );
console.log(
  `Installed pinned dependency. Set OPENCLAW_TEST_BIN=${prefix}/node_modules/.bin/openclaw`,
);
