import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const packageRoot = resolve(root, "packages/openclaw-plugin");
const outputDirectory = resolve(packageRoot, "dist");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(resolve(root, "dist"), { recursive: true });
await build({
  entryPoints: [resolve(packageRoot, "src/index.ts")],
  outfile: resolve(outputDirectory, "index.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  legalComments: "none",
  external: ["@openclaw/gateway-client", "@openclaw/gateway-protocol/*"],
});

process.stdout.write(`Built ${resolve(outputDirectory, "index.mjs")}\n`);
