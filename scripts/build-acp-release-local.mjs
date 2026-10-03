// Produce local archives/tarballs only; --tag here labels artifacts, never Git refs.
import { spawnSync } from "node:child_process";
import {
  readFile,
  mkdir,
  writeFile,
  mkdtemp,
  chmod,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
const repo = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(
  await readFile(join(repo, "packages/gateway-npm/package.json"), "utf8"),
);
const dist = process.env.CARGO_DIST_BIN ?? "dist";
const env = {
  ...process.env,
  AGENT_CONNECT_SESSION_IMAGE: `agent-connect-session:${version}`,
  npm_config_cache:
    process.env.npm_config_cache ?? join(repo, ".agent-connect/npm-cache"),
};
function run(bin, args) {
  const result = spawnSync(bin, args, { cwd: repo, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${bin} failed (${result.status})`);
}
run(process.execPath, ["scripts/acp-release.mjs", "check"]);
await mkdir(join(repo, "dist/acp-release"), { recursive: true });
const plan = spawnSync(
  dist,
  ["plan", "--tag", `v${version}`, "--output-format=json"],
  { cwd: repo, env, encoding: "utf8" },
);
if (plan.status !== 0) throw new Error(`dist plan failed: ${plan.stderr}`);
await writeFile(join(repo, "dist/acp-release/dist-plan.json"), plan.stdout);
const targets = process.argv.includes("--all-linux")
  ? ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"]
  : [
      process.platform === "darwin" && process.arch === "arm64"
        ? "aarch64-apple-darwin"
        : process.platform === "linux" && process.arch === "arm64"
          ? "aarch64-unknown-linux-musl"
          : process.platform === "linux" && process.arch === "x64"
            ? "x86_64-unknown-linux-musl"
            : "unsupported",
    ];
if (targets.includes("unsupported"))
  throw new Error("Local builds support Apple Silicon and Linux x64/ARM64");
const compilers = await mkdtemp(join(tmpdir(), "acp-release-compilers-"));
try {
  for (const target of targets.filter((value) =>
    value.endsWith("-linux-musl"),
  )) {
    const compiler = join(compilers, `${target}-gcc`);
    // cc-rs detects Clang and adds a Rust target triple which Zig cannot parse.
    // This compiler already fixes its target; omit that redundant override.
    await writeFile(
      compiler,
      `#!/usr/bin/env bash\nargs=()\nfor arg in "$@"; do\n  case "$arg" in --target=*) ;; *) args+=("$arg");; esac\ndone\nexec zig cc -target ${target.replace("-unknown", "")} "\${args[@]}"\n`,
    );
    await chmod(compiler, 0o755);
    const key = target.replaceAll("-", "_");
    env[`CC_${key}`] ??= compiler;
    // Rust's bundled LLD understands its musl CRT and architecture errata flags.
    env[`CARGO_TARGET_${key.toUpperCase()}_LINKER`] ??= "rust-lld";
  }
  run(dist, [
    "build",
    "--artifacts=local",
    ...targets.flatMap((target) => ["--target", target]),
    "--tag",
    `v${version}`,
  ]);
  run(dist, ["build", "--artifacts=global", "--tag", `v${version}`]);
  for (const target of targets) {
    run(process.execPath, [
      "scripts/acp-release-info.mjs",
      "record",
      "--target",
      target,
      "--version",
      version,
      "--image",
      env.AGENT_CONNECT_SESSION_IMAGE,
    ]);
  }
  run(process.execPath, [
    "scripts/acp-release.mjs",
    "pack",
    "--local",
    "--image",
    `agent-connect-session:${version}`,
  ]);
} finally {
  await rm(compilers, { recursive: true, force: true });
}
