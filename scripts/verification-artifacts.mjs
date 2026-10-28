// Clean-workflow evidence for explicit local artifact reuse, not a signature.
// Read platform tarballs in memory; never ask tar to write archive paths to disk.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { constants } from "node:fs";
import { chmod, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { releaseTargets, releaseInfoFilename } from "./release-info.mjs";

const exec = promisify(execFile);
export const receiptFilename = "verification-receipt.json";
const maxFileSize = 256 * 1024 * 1024;
const maxExpandedSize = 512 * 1024 * 1024;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sameKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());
function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
function filename(name) {
  ensure(
    typeof name === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
      !name.includes(".."),
    "Unsafe artifact filename",
  );
  return name;
}
async function regularFile(path, maximum = maxFileSize) {
  ensure(
    ["linux", "darwin"].includes(process.platform) &&
      Number.isInteger(constants.O_NOFOLLOW) &&
      constants.O_NOFOLLOW !== 0 &&
      Number.isInteger(constants.O_NONBLOCK) &&
      constants.O_NONBLOCK !== 0,
    "Safe non-following artifact reads are not supported on this platform",
  );
  let file;
  try {
    // Nonblocking open also lets fstat reject a substituted FIFO without waiting.
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(error.code))
      throw new Error(
        "Safe non-following artifact reads are not supported on this filesystem",
        { cause: error },
      );
    throw error;
  }
  try {
    const before = await file.stat();
    ensure(
      before.isFile() &&
        Number.isSafeInteger(before.size) &&
        before.size >= 0 &&
        before.size <= maximum,
      "Artifact must be a bounded regular file",
    );
    // One guard byte detects growth without reading an unbounded replacement.
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await file.stat();
    ensure(
      length === before.size && after.size === before.size,
      "Artifact changed while reading",
    );
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}
async function jsonFile(path) {
  return JSON.parse(await regularFile(path, 1024 * 1024));
}
export async function cleanSourceCommit(repository, expected) {
  const git = async (args) =>
    (
      await exec("git", ["-C", repository, ...args], {
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout.trim();
  const commit = await git(["rev-parse", "--verify", "HEAD"]);
  ensure(
    /^[a-f0-9]{40,64}$/.test(commit),
    "Verification receipt requires a committed source tree",
  );
  ensure(
    !(await git(["status", "--porcelain=v1", "--untracked-files=all"])),
    "Verification receipt requires clean committed source, including untracked files",
  );
  ensure(
    !expected || commit === expected,
    "Source commit changed or does not match verification receipt",
  );
  return commit;
}
export function hostReleaseTarget(
  platform = process.platform,
  arch = process.arch,
) {
  const target = Object.keys(releaseTargets).find(
    (key) =>
      releaseTargets[key][0] === platform && releaseTargets[key][1] === arch,
  );
  ensure(target, `Unsupported verification host: ${platform}/${arch}`);
  return target;
}
export function dockerReleaseTarget(architecture) {
  const arch = {
    aarch64: "arm64",
    arm64: "arm64",
    x86_64: "amd64",
    amd64: "amd64",
  }[architecture];
  ensure(arch, `Unsupported Docker architecture: ${architecture}`);
  return {
    arch,
    target:
      arch === "amd64"
        ? "x86_64-unknown-linux-musl"
        : "aarch64-unknown-linux-musl",
  };
}
function platformFilename(target, version) {
  const [os, cpu] = releaseTargets[target];
  return `open-agent-connect-gateway-${os}-${cpu}-${version}.tgz`;
}
function octal(bytes) {
  let start = 0;
  while (bytes[start] === 32) start++;
  let end = start;
  while (bytes[end] >= 48 && bytes[end] <= 55) end++;
  ensure(
    end > start &&
      bytes.subarray(end).every((byte) => byte === 0 || byte === 32),
    "Invalid tar numeric field or padding",
  );
  const number = Number.parseInt(
    bytes.subarray(start, end).toString("ascii"),
    8,
  );
  ensure(Number.isSafeInteger(number), "Tar numeric field exceeds safe range");
  return number;
}
function tarText(bytes) {
  const end = bytes.indexOf(0);
  const text = end < 0 ? bytes : bytes.subarray(0, end);
  ensure(
    [...text].every((byte) => byte >= 32 && byte < 127),
    "Invalid tar path encoding",
  );
  if (end >= 0)
    ensure(
      bytes.subarray(end).every((byte) => byte === 0),
      "Invalid tar string padding",
    );
  return text.toString("ascii");
}
export function readPlatformArchive(compressed) {
  ensure(
    compressed.length <= maxFileSize,
    "Platform archive exceeds compressed size limit",
  );
  const tar = gunzipSync(compressed, { maxOutputLength: maxExpandedSize });
  ensure(tar.length % 512 === 0, "Invalid tar block padding");
  const allowed = new Set([
    "package/package.json",
    "package/bin/agent-connect",
    "package/bin/session-runner",
    "package/SHA256SUMS",
    "package/LICENSE",
    "package/README.md",
  ]);
  const directories = new Set(["package/", "package/bin/"]);
  const members = new Map();
  const names = new Set();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      ensure(
        tar.length - offset >= 1024 &&
          tar.subarray(offset).every((byte) => byte === 0),
        "Invalid tar end marker",
      );
      ended = true;
      break;
    }
    const checksum = [...header].reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    ensure(
      checksum === octal(header.subarray(148, 156)),
      "Invalid tar checksum",
    );
    const magic = header.subarray(257, 263);
    ensure(
      magic.equals(Buffer.from("ustar\0")) ||
        magic.equals(Buffer.from("ustar ")),
      "Unsupported tar format",
    );
    const prefix = tarText(header.subarray(345, 500));
    ensure(!prefix, "Tar path prefixes are not expected in platform packages");
    const name = tarText(header.subarray(0, 100));
    ensure(!names.has(name), "Duplicate tar member");
    names.add(name);
    const type = header[156];
    const size = octal(header.subarray(124, 136));
    ensure(!tarText(header.subarray(157, 257)), "Tar links are forbidden");
    ensure(
      ((type === 0 || type === 48) && allowed.has(name)) ||
        (type === 53 && directories.has(name) && size === 0),
      "Unexpected or non-regular platform archive member",
    );
    const start = offset + 512;
    const next = start + Math.ceil(size / 512) * 512;
    ensure(
      size <= maxExpandedSize && next <= tar.length,
      "Truncated tar member",
    );
    ensure(
      tar.subarray(start + size, next).every((byte) => byte === 0),
      "Invalid tar member padding",
    );
    if (type === 0 || type === 48)
      members.set(name, tar.subarray(start, start + size));
    offset = next;
  }
  ensure(ended && members.size === allowed.size, "Incomplete platform archive");
  return members;
}
function checksums(text, expected) {
  const found = new Map();
  for (const line of text.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_./-]+)$/.exec(line);
    ensure(
      match && !found.has(match[2]),
      "Invalid or duplicate checksum entry",
    );
    found.set(match[2], match[1]);
  }
  ensure(
    found.size === expected.size &&
      [...expected].every(([name, hash]) => found.get(name) === hash),
    "Internal artifact checksums do not match",
  );
}
function inspectPlatform(bytes, target, version, evidence) {
  const members = readPlatformArchive(bytes);
  const manifest = JSON.parse(members.get("package/package.json"));
  const [os, cpu] = releaseTargets[target];
  ensure(
    manifest.name === `@open-agent-connect/gateway-${os}-${cpu}` &&
      manifest.version === version &&
      JSON.stringify(manifest.os) === JSON.stringify([os]) &&
      JSON.stringify(manifest.cpu) === JSON.stringify([cpu]) &&
      !manifest.scripts,
    "Platform package metadata mismatch",
  );
  const gateway = members.get("package/bin/agent-connect");
  const runner = members.get("package/bin/session-runner");
  checksums(
    members.get("package/SHA256SUMS").toString("utf8"),
    new Map([
      ["bin/agent-connect", sha(gateway)],
      ["bin/session-runner", sha(runner)],
    ]),
  );
  ensure(
    sameKeys(evidence, [
      "schemaVersion",
      "target",
      "version",
      "binarySha256",
    ]) &&
      evidence.schemaVersion === 1 &&
      evidence.target === target &&
      evidence.version === version &&
      evidence.binarySha256 === sha(gateway),
    "Platform release-info evidence mismatch",
  );
  return { gateway, runner };
}
async function inspectRelease({
  repository,
  directory,
  targets,
  expectedArtifacts,
  snapshot,
}) {
  const gateway = await jsonFile(
    join(repository, "packages/gateway-npm/package.json"),
  );
  const sdk = await jsonFile(join(repository, "packages/web-sdk/package.json"));
  const releaseBytes = await regularFile(
    join(directory, "release.json"),
    1024 * 1024,
  );
  const release = JSON.parse(releaseBytes);
  ensure(
    sameKeys(release, [
      "schemaVersion",
      "version",
      "sdkVersion",
      "targets",
      "localOnly",
      "artifacts",
    ]) &&
      release.schemaVersion === 1 &&
      release.localOnly === true &&
      release.version === gateway.version &&
      release.sdkVersion === sdk.version,
    "Release manifest metadata mismatch",
  );
  ensure(
    Array.isArray(release.targets) &&
      release.targets.length === Object.keys(releaseTargets).length &&
      new Set(release.targets).size === release.targets.length &&
      release.targets.every((target) => releaseTargets[target]),
    "Release target metadata mismatch",
  );
  ensure(
    Array.isArray(targets) &&
      targets.length > 0 &&
      new Set(targets).size === targets.length &&
      targets.every((target) => releaseTargets[target]),
    "Invalid receipt targets",
  );
  ensure(
    release.artifacts &&
      typeof release.artifacts === "object" &&
      !Array.isArray(release.artifacts),
    "Invalid release artifacts",
  );
  const names = Object.keys(release.artifacts).map(filename).sort();
  const requiredNames = [
    `open-agent-connect-gateway-${gateway.version}.tgz`,
    `open-agent-connect-web-${sdk.version}.tgz`,
    "acp-chat-sample.tgz",
    ...targets.flatMap((target) => [
      platformFilename(target, gateway.version),
      `agent-connect-gateway-${target}.tar.xz`,
      releaseInfoFilename(target),
    ]),
  ];
  const allowedNames = new Set([
    ...requiredNames,
    "agent-connect-gateway-installer.sh",
  ]);
  ensure(
    names.every((name) => allowedNames.has(name)),
    "Unexpected release artifact in manifest",
  );
  for (const name of requiredNames)
    ensure(names.includes(name), `Missing packed acceptance artifact: ${name}`);
  ensure(
    !names.includes(receiptFilename) &&
      !names.includes("release.json") &&
      !names.includes("SHA256SUMS"),
    "Release manifest contains reserved artifacts",
  );
  const allNames = [...names, "release.json", "SHA256SUMS"].sort();
  const actual = (await readdir(directory))
    .filter((name) => name !== receiptFilename)
    .sort();
  ensure(
    JSON.stringify(actual) === JSON.stringify(allNames),
    "Unexpected or missing release artifact file set",
  );
  if (expectedArtifacts !== undefined)
    ensure(
      sameKeys(expectedArtifacts, allNames),
      "Receipt artifact file set mismatch",
    );
  const availableTargets = Object.keys(releaseTargets)
    .filter((target) =>
      names.includes(platformFilename(target, gateway.version)),
    )
    .sort();
  ensure(
    JSON.stringify(availableTargets) === JSON.stringify([...targets].sort()),
    "Receipt targets do not match platform payloads",
  );
  const hashes = {};
  const packages = new Map();
  const releaseInfo = new Map();
  let checksumBytes;
  if (snapshot) await mkdir(snapshot);
  for (const name of allNames) {
    const bytes =
      name === "release.json"
        ? releaseBytes
        : await regularFile(join(directory, name));
    const digest = { sha256: sha(bytes), size: bytes.length };
    hashes[name] = digest;
    const specs = [];
    if (Object.hasOwn(release.artifacts, name))
      specs.push(release.artifacts[name]);
    if (expectedArtifacts !== undefined) specs.push(expectedArtifacts[name]);
    for (const spec of specs)
      ensure(
        sameKeys(spec, ["sha256", "size"]) &&
          spec.sha256 === digest.sha256 &&
          spec.size === digest.size,
        `Artifact checksum mismatch: ${name}`,
      );
    if (snapshot)
      await writeFile(join(snapshot, name), bytes, { flag: "wx", mode: 0o600 });
    if (name.endsWith(".tgz")) packages.set(name, bytes);
    if (name === "SHA256SUMS") checksumBytes = bytes;
    if (name.endsWith(".release-info.json"))
      releaseInfo.set(name, JSON.parse(bytes));
  }
  checksums(
    checksumBytes.toString("utf8"),
    new Map(names.map((name) => [name, hashes[name].sha256])),
  );
  const payloads = new Map();
  for (const target of targets) {
    ensure(
      names.includes(`agent-connect-gateway-${target}.tar.xz`) &&
        names.includes(releaseInfoFilename(target)),
      `Missing release archive/evidence for ${target}`,
    );
    const evidence = releaseInfo.get(releaseInfoFilename(target));
    payloads.set(
      target,
      inspectPlatform(
        packages.get(platformFilename(target, gateway.version)),
        target,
        gateway.version,
        evidence,
      ),
    );
  }
  return {
    version: gateway.version,
    sdkVersion: sdk.version,
    hashes,
    payloads,
  };
}
export async function writeVerificationReceipt({
  repository,
  directory,
  targets,
  commit,
}) {
  ensure(
    typeof commit === "string" && /^[a-f0-9]{40,64}$/.test(commit),
    "Receipt producer requires its pre-build source commit",
  );
  await cleanSourceCommit(repository, commit);
  const { version, sdkVersion, hashes } = await inspectRelease({
    repository,
    directory,
    targets,
  });
  await cleanSourceCommit(repository, commit);
  await writeFile(
    join(directory, receiptFilename),
    JSON.stringify(
      {
        schemaVersion: 1,
        commit,
        version,
        sdkVersion,
        targets,
        artifacts: hashes,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}
export async function prepareReleaseArtifacts({ repository, directory, work }) {
  const receipt = await jsonFile(join(directory, receiptFilename));
  ensure(
    sameKeys(receipt, [
      "schemaVersion",
      "commit",
      "version",
      "sdkVersion",
      "targets",
      "artifacts",
    ]) &&
      receipt.schemaVersion === 1 &&
      typeof receipt.commit === "string" &&
      /^[a-f0-9]{40,64}$/.test(receipt.commit) &&
      receipt.artifacts !== null &&
      typeof receipt.artifacts === "object" &&
      !Array.isArray(receipt.artifacts),
    "Invalid verification receipt",
  );
  await cleanSourceCommit(repository, receipt.commit);
  const snapshot = join(work, "release-artifacts");
  const result = await inspectRelease({
    repository,
    directory,
    targets: receipt.targets,
    expectedArtifacts: receipt.artifacts,
    snapshot,
  });
  ensure(
    result.version === receipt.version &&
      result.sdkVersion === receipt.sdkVersion,
    "Receipt version mismatch",
  );
  await cleanSourceCommit(repository, receipt.commit);
  return { ...result, directory: snapshot, commit: receipt.commit };
}
export async function extractVerificationBinaries({
  prepared,
  work,
  architecture,
  run,
  platform,
  arch,
}) {
  const hostTarget = hostReleaseTarget(platform, arch);
  const docker = dockerReleaseTarget(architecture);
  const host = prepared.payloads.get(hostTarget);
  const linux = prepared.payloads.get(docker.target);
  ensure(host, `Missing host gateway payload for ${hostTarget}`);
  ensure(linux, `Missing Docker Linux runner payload for ${docker.target}`);
  const gateway = join(work, "agent-connect");
  const runner = join(work, "session-runner");
  await writeFile(gateway, host.gateway, { flag: "wx", mode: 0o700 });
  await chmod(gateway, 0o700);
  await writeFile(runner, linux.runner, { flag: "wx", mode: 0o755 });
  // Docker COPY retains this mode but assigns root ownership; USER node must run it.
  await chmod(runner, 0o755);
  const info = JSON.parse(
    await run(gateway, ["release-info"], { capture: true }),
  );
  ensure(
    info.version === prepared.version,
    "Executable gateway release-info version mismatch",
  );
  return { gateway, runner, arch: docker.arch };
}
