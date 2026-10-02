import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

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

// Build exactly the browser distribution, even if inherited compiler options
// change. Source/declaration maps could expose repository source paths.
for (const entry of readdirSync(outputDirectory, {
  recursive: true,
  withFileTypes: true,
})) {
  if (!entry.isFile()) continue;
  const path = join(entry.parentPath, entry.name);
  if (!/\.(?:js|d\.ts)$/.test(entry.name) || /\.test\./.test(entry.name)) {
    throw new Error(`Unexpected Web SDK build artifact: ${entry.name}`);
  }
  if (/sourceMappingURL/.test(readFileSync(path, "utf8"))) {
    throw new Error(
      `Web SDK build leaked a source map reference: ${entry.name}`,
    );
  }
}
