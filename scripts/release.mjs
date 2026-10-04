// Explicit ACP artifact preparation. Publication requires the protected workflow.
import { spawnSync } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  cp,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import {
  verifyArchiveReleaseInfo,
  releaseInfoFilename,
} from "./release-info.mjs";

const repo = resolve(import.meta.dirname, "..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    directory: { type: "string", default: "dist/release" },
    image: { type: "string" },
    local: { type: "boolean", default: false },
    artifacts: { type: "string", default: "target/distrib" },
  },
});
const command = positionals[0];
const output = resolve(repo, values.directory);
const json = async (path) =>
  JSON.parse(await readFile(join(repo, path), "utf8"));
const sdk = await json("packages/web-sdk/package.json");
const gateway = await json("packages/gateway-npm/package.json");
const session = await json("deploy/gateway/session/package.json");
const cargo = await readFile(join(repo, "crates/gateway/Cargo.toml"), "utf8");
const version = gateway.version;
if (
  ![session.version, cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]].every(
    (v) => v === version,
  )
)
  throw new Error(
    "Gateway, Cargo crate and session image manifest must share one version",
  );
if (!/^0\.0\.\d+$/.test(sdk.version) || !/^0\.0\.\d+$/.test(version))
  throw new Error(
    "SDK and gateway must remain on independently versioned 0.0.x releases",
  );
for (const [name, pin] of Object.entries(gateway.agentConnect.adapterVersions))
  if (session.dependencies[name] !== pin)
    throw new Error(`Session image adapter pin mismatch: ${name}`);
if (!Object.values(gateway.optionalDependencies).every((v) => v === version))
  throw new Error("Platform package versions must match the gateway");
function run(bin, args, cwd = repo) {
  const result = spawnSync(bin, args, {
    cwd,
    env: {
      ...process.env,
      npm_config_cache:
        process.env.npm_config_cache ?? join(repo, ".agent-connect/npm-cache"),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${bin} exited ${result.status}: ${result.stderr.slice(-5000)}`,
    );
  return result.stdout;
}
const targets = [
  "aarch64-apple-darwin",
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
];
function imageRef() {
  const image = values.image;
  if (
    !image ||
    (!values.local && !/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(image))
  )
    throw new Error(
      "--image must be an immutable registry digest; --local permits a local test tag",
    );
  if (values.local && !/^[a-zA-Z0-9./_:@-]+$/.test(image))
    throw new Error("Invalid local image reference");
  return image;
}
async function writeMetadata() {
  const artifacts = {};
  for (const filename of (await readdir(output)).sort()) {
    if (!/\.(?:tgz|tar\.xz|sh|sha256|release-info\.json)$/.test(filename))
      continue;
    const bytes = await readFile(join(output, filename));
    artifacts[filename] = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
  }
  await writeFile(
    join(output, "release.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        version,
        sessionImage: imageRef(),
        adapterVersions: gateway.agentConnect.adapterVersions,
        sdkVersion: sdk.version,
        targets,
        localOnly: values.local,
        artifacts,
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(output, "SHA256SUMS"),
    Object.entries(artifacts)
      .map(([name, { sha256 }]) => `${sha256}  ${name}\n`)
      .join(""),
  );
}
async function pack(path) {
  const packed = JSON.parse(
    run("npm", [
      "pack",
      path,
      "--json",
      "--pack-destination",
      output,
      "--ignore-scripts",
    ]),
  );
  return packed[0].filename;
}
if (command === "check") {
  console.log(`ACP release versions and adapter pins agree: ${version}`);
} else if (command === "pack") {
  imageRef();
  const artifacts = resolve(repo, values.artifacts);
  const available = await readdir(artifacts);
  if (
    !values.local &&
    !targets.every((target) =>
      available.includes(`agent-connect-gateway-${target}.tar.xz`),
    )
  )
    throw new Error(
      "A publishable release requires archives for all three supported targets",
    );
  // Validate every available executable before producing any npm artifacts.
  const releaseEvidence = [];
  for (const target of targets) {
    const filename = `agent-connect-gateway-${target}.tar.xz`;
    if (!available.includes(filename)) continue;
    const evidence = await verifyArchiveReleaseInfo({
      archive: join(artifacts, filename),
      target,
      version,
      sessionImage: imageRef(),
    });
    releaseEvidence.push([target, evidence]);
  }
  await mkdir(output, { recursive: true });
  for (const [target, evidence] of releaseEvidence)
    await writeFile(
      join(output, releaseInfoFilename(target)),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  for (const target of targets) {
    const filename = `agent-connect-gateway-${target}.tar.xz`;
    if (!(await readdir(artifacts)).includes(filename)) continue;
    const archive = join(artifacts, filename);
    const staging = await mkdtemp(join(tmpdir(), "acp-platform-pack-"));
    try {
      const entries = run("tar", ["-tf", archive]).trim().split("\n");
      if (
        entries.some(
          (entry) => entry.startsWith("/") || entry.split("/").includes(".."),
        )
      )
        throw new Error("Unsafe release archive paths");
      run("tar", ["-xf", archive, "-C", staging]);
      if (!entries.some((entry) => /(?:^|\/)agent-connect$/.test(entry)))
        throw new Error(`No primary agent-connect executable in ${filename}`);
      const executable = entries.find((entry) =>
        /(?:^|\/)agent-connect-gateway$/.test(entry),
      );
      if (!executable) throw new Error(`No gateway executable in ${filename}`);
      run(process.execPath, [
        "scripts/package-gateway.mjs",
        target,
        join(staging, executable),
      ]);
      const platform = target.startsWith("aarch64-apple")
        ? "darwin-arm64"
        : target.startsWith("aarch64")
          ? "linux-arm64"
          : "linux-x64";
      await pack(`./dist/gateway/${platform}`);
      await cp(archive, join(output, filename));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  run("npm", ["run", "build", "--workspace", "@open-agent-connect/web"]);
  await pack("./packages/web-sdk");
  await pack("./packages/gateway-npm");
  const sample = await mkdtemp(join(tmpdir(), "acp-sample-pack-"));
  try {
    await cp(join(repo, "examples/acp-chat"), join(sample, "package"), {
      recursive: true,
      filter: (path) =>
        !path.split(/[\\/]/).some((p) => ["node_modules", "dist"].includes(p)),
    });
    run("tar", [
      "-czf",
      join(output, "acp-chat-sample.tgz"),
      "-C",
      sample,
      "package",
    ]);
  } finally {
    await rm(sample, { recursive: true, force: true });
  }
  for (const file of ["agent-connect-gateway-installer.sh"])
    if ((await readdir(artifacts)).includes(file))
      await cp(join(artifacts, file), join(output, file));
  await writeMetadata();
  console.log(`Prepared local ACP release artifacts for ${version}`);
} else if (command === "publish-dry-run" || command === "publish") {
  const metadata = JSON.parse(
    await readFile(join(output, "release.json"), "utf8"),
  );
  if (metadata.version !== version || metadata.sdkVersion !== sdk.version)
    throw new Error("Release metadata version mismatch");
  if (
    command === "publish" &&
    (metadata.localOnly ||
      process.env.GITHUB_ACTIONS !== "true" ||
      !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
      process.env.AGENT_CONNECT_PUBLISH_APPROVED !== version)
  )
    throw new Error(
      "Publication requires a digest-pinned candidate and explicit protected OIDC workflow approval",
    );
  const packages = Object.keys(metadata.artifacts)
    .filter((name) => name.endsWith(".tgz") && name !== "acp-chat-sample.tgz")
    .sort(
      (a, b) =>
        (a.includes("gateway-0") ? 1 : 0) - (b.includes("gateway-0") ? 1 : 0),
    );
  for (const filename of packages) {
    const path = join(output, basename(filename));
    const sha = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (sha !== metadata.artifacts[filename].sha256)
      throw new Error(`Artifact checksum mismatch: ${filename}`);
    run("npm", [
      "publish",
      path,
      "--access",
      "public",
      "--tag",
      "next",
      "--ignore-scripts",
      ...(command === "publish-dry-run" ? ["--dry-run"] : ["--provenance"]),
    ]);
  }
  console.log(`ACP ${command} checked ${packages.length} packages`);
} else
  throw new Error(
    "Usage: release.mjs check | pack --image <ref> [--local] | publish-dry-run | publish",
  );
