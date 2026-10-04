// Install exact release tarballs in a disposable consumer; never publish.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const [wrapper, platform] = process.argv.slice(2).map((p) => resolve(p));
if (!wrapper || !platform)
  throw new Error(
    "Usage: smoke-gateway-package.mjs <launcher.tgz> <platform.tgz>",
  );
const dir = await mkdtemp(join(tmpdir(), "gateway-consumer-"));
const env = {
  PATH: process.env.PATH,
  HOME: dir,
  npm_config_cache: join(dir, "cache"),
  npm_config_audit: "false",
  npm_config_fund: "false",
};
function run(bin, args) {
  const result = spawnSync(bin, args, { cwd: dir, env, encoding: "utf8" });
  assert.equal(result.status, 0, `${bin}: ${result.stderr}`);
  return result.stdout;
}
run("npm", ["init", "--yes"]);
run("npm", ["install", "--ignore-scripts", wrapper, platform]);
const help = run("npx", [
  "--no-install",
  "@open-agent-connect/gateway",
  "--help",
]);
assert.match(help, /serve/i);
assert.match(help, /login/i);
assert.match(help, /init/i);
assert.match(help, /egress/i);
const manifest = JSON.parse(
  await readFile(
    join(dir, "node_modules/@open-agent-connect/gateway/package.json"),
    "utf8",
  ),
);
assert.equal(
  run("npx", [
    "--no-install",
    "@open-agent-connect/gateway",
    "--version",
  ]).trim(),
  `agent-connect-gateway ${manifest.version}`,
);
console.log("Packed gateway npx help/version passed");
