import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "packages/gateway/src/openclaw-plugin/index.ts");
const sourceManifest = resolve(
  root,
  "packages/gateway/src/openclaw-plugin/openclaw.plugin.json",
);
const outputDirectory = resolve(root, "dist/openclaw-plugin");
const output = resolve(outputDirectory, "index.mjs");

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [source],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  legalComments: "none",
  external: ["openclaw/plugin-sdk/*"],
});
await cp(sourceManifest, resolve(outputDirectory, "openclaw.plugin.json"));
await writeFile(
  resolve(outputDirectory, "package.json"),
  `${JSON.stringify(
    {
      name: "agent-connect-openclaw",
      version: "0.0.0",
      private: true,
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    },
    null,
    2,
  )}\n`,
  { encoding: "utf8", mode: 0o644 },
);

process.stdout.write(`Built ${output}\n`);
