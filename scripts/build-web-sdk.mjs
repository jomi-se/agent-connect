import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageRoot = resolve(repositoryRoot, "packages/web-sdk");
const outputDirectory = resolve(packageRoot, "dist");
const typescript = resolve(repositoryRoot, "node_modules/typescript/bin/tsc");

rmSync(outputDirectory, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [typescript, "-p", resolve(packageRoot, "tsconfig.build.json")],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Web SDK build failed with exit ${result.status}`);
}
