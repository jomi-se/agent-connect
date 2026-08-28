#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smokeRoot = join(repoRoot, ".agent-connect", "web-sdk-package-smoke");
const packagesDir = join(smokeRoot, "packages");
const consumerDir = join(smokeRoot, "consumer");
const cacheDir = join(smokeRoot, "npm-cache");

rmSync(smokeRoot, { recursive: true, force: true });
mkdirSync(packagesDir, { recursive: true });
mkdirSync(consumerDir, { recursive: true });

requireBrowserSafeSources();
run("npm", ["run", "build", "--workspace", "@agent-connect/web"]);
const packed = run(
  "npm",
  [
    "pack",
    "--json",
    "--workspace",
    "@agent-connect/web",
    "--pack-destination",
    packagesDir,
  ],
  true,
);
const packResult = JSON.parse(packed);
const filename = packResult[0]?.filename;
if (typeof filename !== "string") {
  throw new Error("npm pack did not report an SDK tarball");
}
const tarball = join(packagesDir, filename);

writeFileSync(
  join(consumerDir, "package.json"),
  JSON.stringify(
    {
      name: "agent-connect-external-consumer-smoke",
      private: true,
      type: "module",
      dependencies: { "@agent-connect/web": `file:${tarball}` },
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(consumerDir, "check.mjs"),
  `import { defineTool, parseRuntimeCard } from "@agent-connect/web";

const tool = defineTool({
  name: "external_consumer_tool",
  description: "Prove the installed package executes consumer code",
  inputSchema: { type: "object", additionalProperties: false },
  execute: () => "external-consumer-ok",
});
const card = parseRuntimeCard(JSON.stringify({
  version: 1,
  runtimeId: "sha256:external-consumer",
  endpoint: "https://runtime.example",
  connectorPublicKey: {
    kty: "OKP",
    crv: "Ed25519",
    x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  },
  transportProfile: "tailscale-serve",
  authorizationServer: "https://runtime.example"
}));
if (tool.name !== "external_consumer_tool" ||
    card.runtimeId !== "sha256:external-consumer") process.exit(1);
process.stdout.write("external-consumer-ok\\n");
`,
);

run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], false, {
  cwd: consumerDir,
});
const result = run("node", ["check.mjs"], true, { cwd: consumerDir }).trim();
if (result !== "external-consumer-ok") {
  throw new Error(`Unexpected consumer result: ${result}`);
}

const installedPackage = JSON.parse(
  readFileSync(
    join(consumerDir, "node_modules", "@agent-connect", "web", "package.json"),
    "utf8",
  ),
);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    package: installedPackage.name,
    version: installedPackage.version,
    consumer: "clean npm tarball install",
  })}\n`,
);

function run(command, args, capture = false, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
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

/**
 * The browser SDK must not reach for a Node built-in. The package tsconfig
 * omits Node types, which catches globals; this catches an explicit
 * `node:` import, which would only fail once a bundler tried to resolve it.
 */
function requireBrowserSafeSources() {
  const sourceRoot = join(repoRoot, "packages", "web-sdk", "src");
  const offenders = [];
  for (const entry of readdirSync(sourceRoot, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const path = join(entry.parentPath ?? sourceRoot, entry.name);
    if (/\bfrom "node:/.test(readFileSync(path, "utf8"))) {
      offenders.push(path);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Browser SDK sources import Node built-ins: ${offenders.join(", ")}`,
    );
  }
}
