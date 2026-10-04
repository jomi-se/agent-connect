// Execute release-info on build runners; bind cross-platform evidence to archive binaries.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, lstat, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const releaseTargets = {
  "aarch64-apple-darwin": ["darwin", "arm64"],
  "x86_64-unknown-linux-musl": ["linux", "x64"],
  "aarch64-unknown-linux-musl": ["linux", "arm64"],
};
function run(bin, args) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${bin} exited ${result.status}: ${result.stderr.slice(-2000)}`,
    );
  return result.stdout;
}
export function releaseInfoFilename(target) {
  return `agent-connect-gateway-${target}.release-info.json`;
}
function checkInfo(info, { target, version, sessionImage }) {
  if (info.version !== version)
    throw new Error(`Compiled gateway version mismatch for ${target}`);
  if (info.sessionImage !== sessionImage)
    throw new Error(`Compiled gateway session image mismatch for ${target}`);
}
function commandFor(target, binary) {
  const [os, arch] = releaseTargets[target] ?? [];
  if (!os) throw new Error(`Unsupported release target: ${target}`);
  if (os === process.platform && arch === process.arch)
    return [binary, ["release-info"]];
  if (os === "linux" && process.platform === "linux") {
    const runner =
      arch === "x64"
        ? (process.env.AGENT_CONNECT_RELEASE_RUNNER_X86_64 ?? "qemu-x86_64")
        : (process.env.AGENT_CONNECT_RELEASE_RUNNER_ARM64 ?? "qemu-aarch64");
    return [runner, [binary, "release-info"]];
  }
  throw new Error(
    `Cannot execute ${target}; record release-info on its native build runner`,
  );
}
export async function verifyArchiveReleaseInfo({
  archive,
  target,
  version,
  sessionImage,
  record = false,
}) {
  const expected = { target, version, sessionImage };
  const directory = await mkdtemp(join(tmpdir(), "release-info-"));
  try {
    const entries = run("tar", ["-tf", archive]).trim().split("\n");
    if (
      entries.some(
        (entry) => entry.startsWith("/") || entry.split("/").includes(".."),
      )
    )
      throw new Error("Unsafe release archive paths");
    const primary = entries.find((entry) =>
      /(?:^|\/)agent-connect$/.test(entry),
    );
    const compatibility = entries.find((entry) =>
      /(?:^|\/)agent-connect-gateway$/.test(entry),
    );
    if (!primary || !compatibility)
      throw new Error(`Both gateway executables are required in ${archive}`);
    run("tar", ["-xf", archive, "-C", directory, "--", primary, compatibility]);
    const paths = [primary, compatibility].map((entry) =>
      join(directory, entry),
    );
    const hashes = [];
    for (const path of paths) {
      if (!(await lstat(path)).isFile())
        throw new Error("Gateway executable must be a regular file");
      hashes.push(
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      );
    }
    const sidecar = join(dirname(archive), releaseInfoFilename(target));
    const native =
      releaseTargets[target]?.[0] === process.platform &&
      releaseTargets[target]?.[1] === process.arch;
    let info;
    if (record || native) {
      for (const path of paths) {
        const [bin, args] = commandFor(target, path);
        const compiled = JSON.parse(run(bin, args));
        checkInfo(compiled, expected);
      }
      info = {
        schemaVersion: 1,
        ...expected,
        primarySha256: hashes[0],
        binarySha256: hashes[1],
      };
      if (record)
        await writeFile(sidecar, JSON.stringify(info, null, 2) + "\n");
    } else {
      try {
        const metadata = await lstat(sidecar);
        if (!metadata.isFile() || metadata.size > 16 * 1024)
          throw new Error("Invalid release-info evidence file");
        info = JSON.parse(await readFile(sidecar, "utf8"));
        if (
          !info ||
          typeof info !== "object" ||
          Array.isArray(info) ||
          Object.keys(info).sort().join(",") !==
            "binarySha256,primarySha256,schemaVersion,sessionImage,target,version" ||
          !/^[a-f0-9]{64}$/.test(info.primarySha256) ||
          !/^[a-f0-9]{64}$/.test(info.binarySha256)
        )
          throw new Error("Invalid release-info evidence fields");
      } catch (error) {
        throw new Error(
          `Missing or invalid release-info evidence for ${target}; run scripts/release-info.mjs record on a native runner or with QEMU`,
          { cause: error },
        );
      }
      checkInfo(info, expected);
      if (
        info.schemaVersion !== 1 ||
        info.target !== target ||
        info.primarySha256 !== hashes[0] ||
        info.binarySha256 !== hashes[1]
      )
        throw new Error(
          `Release-info evidence does not match archive binaries for ${target}`,
        );
    }
    return info;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      target: { type: "string" },
      version: { type: "string" },
      image: { type: "string" },
      artifacts: { type: "string", default: "target/distrib" },
    },
  });
  if (
    positionals[0] !== "record" ||
    !values.target ||
    !values.version ||
    !values.image
  )
    throw new Error(
      "Usage: release-info.mjs record --target <target> --version <version> --image <ref> [--artifacts <directory>]",
    );
  await verifyArchiveReleaseInfo({
    archive: resolve(
      values.artifacts,
      `agent-connect-gateway-${values.target}.tar.xz`,
    ),
    target: values.target,
    version: values.version,
    sessionImage: values.image,
    record: true,
  });
  console.log(`Recorded executable release-info for ${values.target}`);
}
