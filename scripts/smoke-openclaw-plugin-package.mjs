#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tarball = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!tarball) {
  throw new Error(
    "Usage: node scripts/smoke-openclaw-plugin-package.mjs <tarball>",
  );
}
const expected = JSON.parse(
  readFileSync(join(repoRoot, "packages/openclaw-plugin/package.json"), "utf8"),
);

const smokeRoot = join(
  repoRoot,
  ".agent-connect",
  "openclaw-plugin-package-smoke",
);
const cacheDir = join(smokeRoot, "npm-cache");
rmSync(smokeRoot, { recursive: true, force: true });
mkdirSync(smokeRoot, { recursive: true });
writeFileSync(
  join(smokeRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "agent-connect-openclaw-plugin-external-smoke",
      private: true,
      type: "module",
      dependencies: {
        "@open-agent-connect/openclaw-plugin": `file:${tarball}`,
        openclaw: expected.peerDependencies.openclaw,
      },
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(smokeRoot, "check.mjs"),
  `import plugin from "@open-agent-connect/openclaw-plugin";
if (plugin?.id !== "agent-connect" || typeof plugin.register !== "function") {
  throw new Error("Packed OpenClaw plugin did not expose the expected host plugin");
}
process.stdout.write("external-plugin-import-ok\\n");
`,
);

run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
run("npm", ["ls", "--all"]);
const imported = run("node", ["check.mjs"], true).trim();
if (imported !== "external-plugin-import-ok") {
  throw new Error(`Unexpected plugin import result: ${imported}`);
}

const installed = JSON.parse(
  readFileSync(
    join(
      smokeRoot,
      "node_modules/@open-agent-connect/openclaw-plugin/package.json",
    ),
    "utf8",
  ),
);
if (
  installed.name !== "@open-agent-connect/openclaw-plugin" ||
  installed.version !== expected.version ||
  installed.peerDependencies?.openclaw !== expected.peerDependencies.openclaw
) {
  throw new Error(
    "Installed plugin metadata does not retain the supported host pin",
  );
}
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    package: installed.name,
    version: installed.version,
    consumer: "clean npm tarball install with pinned OpenClaw peer",
  })}\n`,
);

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: smokeRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cacheDir },
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    if (capture) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result.stdout ?? "";
}
