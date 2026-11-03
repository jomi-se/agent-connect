import { architectureFormat, engine } from "./container-engine.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  cleanSourceCommit,
  prepareReleaseArtifacts,
  extractVerificationBinaries,
  dockerReleaseTarget,
} from "./verification-artifacts.mjs";
import { testBoxImage, removeTestImages } from "./test-box-images.mjs";

async function command(binary, args, { cwd, env, capture = false }) {
  const child = spawn(binary, args, {
    cwd,
    env,
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
  });
  let output = "";
  if (capture)
    child.stdout.on("data", (bytes) => {
      output += bytes;
    });
  await new Promise((ok, fail) => {
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (code === 0) ok();
      else
        fail(
          Object.assign(new Error(`${binary} exited ${code ?? signal}`), {
            exitCode: code ?? 1,
          }),
        );
    });
  });
  return output;
}

export const steps = [
  "format:check",
  "typecheck",
  "test:docs",
  "test",
  "build",
  "test:ui:owner",
  "test:integration:gateway",
  "test:integration:gateway:boxed",
  "test:integration:gateway:teardown",
  "test:integration:gateway:clean-room",
];

async function timed(label, action) {
  const start = Date.now();
  try {
    return await action();
  } finally {
    console.log(
      `verify: ${label} ${((Date.now() - start) / 1000).toFixed(1)}s`,
    );
  }
}

// Runs the given steps (default: all) against one test box built from this checkout.
export async function verify({
  repository = resolve(import.meta.dirname, ".."),
  run = command,
  only = steps,
  releaseArtifacts,
  hostPlatform = process.platform,
  hostArch = process.arch,
} = {}) {
  if (
    releaseArtifacts !== undefined &&
    (typeof releaseArtifacts !== "string" || !releaseArtifacts.trim())
  )
    throw new Error("--release-artifacts requires an artifact directory");
  const unknown = only.filter((step) => !steps.includes(step));
  if (unknown.length)
    throw new Error(
      `Unknown verify step: ${unknown.join(", ")}; choose from ${steps.join(", ")}`,
    );
  const box = join(repository, "deploy/gateway/box");
  const { version } = JSON.parse(
    await readFile(join(box, "package.json"), "utf8"),
  );
  const image = testBoxImage(version, randomUUID());
  const work = await mkdtemp(join(resolve(tmpdir()), "agent-connect-verify-"));
  const env = { ...process.env, ACP_BOX_IMAGE: image };
  // This orchestrator selects the mode; child fixture tests can still run source mode.
  delete env.ACP_GATEWAY_BIN;
  delete env.ACP_GATEWAY_MODE;
  delete env.AGENT_CONNECT_VERIFY_RELEASE_ARTIFACTS;
  let prepared;
  let boxAttempted = false;
  const options = { cwd: repository, env };
  const docker = (args, capture = false) =>
    run(engine, args, {
      ...options,
      capture,
      env: { ...env, DOCKER_CONFIG: join(work, "docker-config") },
    });
  try {
    if (releaseArtifacts)
      prepared = await prepareReleaseArtifacts({
        repository,
        directory: resolve(releaseArtifacts),
        work,
      });
    else
      await timed("session-runners", () =>
        run("./deploy/gateway/box/build-local.sh", [], options),
      );
    const architecture = (
      await docker(["info", "--format", architectureFormat], true)
    ).trim();
    const { arch } = dockerReleaseTarget(architecture);
    let runner = join(
      repository,
      `target/distrib/session-runner-linux-${arch}`,
    );
    if (prepared) {
      const binaries = await extractVerificationBinaries({
        prepared,
        work,
        architecture,
        platform: hostPlatform,
        arch: hostArch,
        run: (binary, args, extra) =>
          run(binary, args, { ...options, ...extra }),
      });
      runner = binaries.runner;
      env.ACP_GATEWAY_MODE = "release-artifacts";
      env.ACP_GATEWAY_BIN = binaries.gateway;
      env.AGENT_CONNECT_RELEASE_DIR = prepared.directory;
      await cleanSourceCommit(repository, prepared.commit);
    }
    const context = join(work, "box");
    await mkdir(context);
    for (const file of ["Dockerfile", "entrypoint.sh", "install-harnesses.sh"])
      await copyFile(join(box, file), join(context, file));
    await copyFile(
      join(repository, "deploy/gateway/egress-proxy.mjs"),
      join(context, "egress-proxy.mjs"),
    );
    await copyFile(runner, join(context, "session-runner"));
    boxAttempted = true;
    await timed("test box", () =>
      docker(["build", "--platform", `linux/${arch}`, "--tag", image, context]),
    );
    // Rootless Podman copies an image once per id mapping on first use; do it
    // before the box tests' and sessions' timeouts start, as setup does for
    // owners. The box tests map the owner as itself, sessions onto node.
    if (engine === "podman")
      for (const mapping of ["keep-id", "keep-id:uid=1000,gid=1000"])
        await timed(`test box ${mapping}`, () =>
          docker([
            "run",
            "--rm",
            "--pull=never",
            "--network",
            "none",
            `--userns=${mapping}`,
            "--entrypoint",
            "true",
            image,
          ]),
        );
    for (const step of only) {
      if (prepared) await cleanSourceCommit(repository, prepared.commit);
      await timed(step, () => run("npm", ["run", step], options));
    }
    if (prepared) await cleanSourceCommit(repository, prepared.commit);
  } finally {
    try {
      if (prepared) await cleanSourceCommit(repository, prepared.commit);
    } finally {
      try {
        if (boxAttempted)
          await removeTestImages(image, (args) => docker(args, true));
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { "release-artifacts": { type: "string" } },
    });
    if (
      process.env.ACP_GATEWAY_MODE !== undefined ||
      process.env.ACP_GATEWAY_BIN !== undefined
    )
      throw new Error(
        "verify owns gateway selection; use --release-artifacts instead of ACP_GATEWAY_BIN/ACP_GATEWAY_MODE",
      );
    await verify({
      only: positionals.length ? positionals : steps,
      releaseArtifacts:
        values["release-artifacts"] ??
        process.env.AGENT_CONNECT_VERIFY_RELEASE_ARTIFACTS,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
