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
import { encodedReleaseRustflags } from "./release-build-env.mjs";
const repo = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(
  await readFile(join(repo, "packages/gateway-npm/package.json"), "utf8"),
);
const dist = process.env.CARGO_DIST_BIN ?? "dist";
const env = {
  ...process.env,
  CARGO_ENCODED_RUSTFLAGS: encodedReleaseRustflags(process.env, repo),
  npm_config_cache:
    process.env.npm_config_cache ?? join(repo, ".agent-connect/npm-cache"),
};
function run(bin, args) {
  const result = spawnSync(bin, args, { cwd: repo, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${bin} failed (${result.status})`);
}
run(process.execPath, ["scripts/release.mjs", "check"]);
// Start empty: tarballs from an earlier version would be packed twice.
await rm(join(repo, "dist/release"), { recursive: true, force: true });
await mkdir(join(repo, "dist/release"), { recursive: true });
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
const compilers = await mkdtemp(join(tmpdir(), "release-compilers-"));
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
  run("./deploy/gateway/box/build-local.sh", ["--runners-only"]);
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
      "scripts/release-info.mjs",
      "record",
      "--target",
      target,
      "--version",
      version,
    ]);
  }
  run(process.execPath, ["scripts/release.mjs", "pack", "--local"]);
  run(process.execPath, ["scripts/test-box-setup.mjs"]);
} finally {
  await rm(compilers, { recursive: true, force: true });
}
