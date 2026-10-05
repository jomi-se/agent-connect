// Set the gateway release version everywhere it is declared, then check agreement.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "..");
const version = process.argv[2];
if (!/^0\.0\.\d+$/.test(version ?? ""))
  throw new Error("Usage: npm run release:bump 0.0.<n>");

async function editJson(path, change) {
  const file = join(repo, path);
  const json = JSON.parse(await readFile(file, "utf8"));
  change(json);
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
}
async function replace(path, pattern, replacement) {
  const file = join(repo, path);
  const text = await readFile(file, "utf8");
  if (!pattern.test(text)) throw new Error(`No version found in ${path}`);
  await writeFile(file, text.replace(pattern, replacement));
}

for (const path of [
  "packages/gateway-npm/package.json",
  "deploy/gateway/box/package.json",
  "examples/acp-chat/package.json",
])
  await editJson(path, (json) => (json.version = version));
await editJson("deploy/gateway/box/package-lock.json", (json) => {
  json.version = version;
  json.packages[""].version = version;
});
await editJson("package-lock.json", (json) => {
  json.packages["packages/gateway-npm"].version = version;
});
await replace(
  "crates/gateway/Cargo.toml",
  /^version = "[^"]+"/m,
  `version = "${version}"`,
);
await replace(
  "Cargo.lock",
  /(name = "agent-connect-gateway"\nversion = )"[^"]+"/,
  `$1"${version}"`,
);
const check = spawnSync(process.execPath, ["scripts/release.mjs", "check"], {
  cwd: repo,
  stdio: "inherit",
});
process.exit(check.status ?? 1);
