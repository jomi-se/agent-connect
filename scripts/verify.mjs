import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

export async function verify({
  repository = resolve(import.meta.dirname, ".."),
  run = command,
} = {}) {
  const box = join(repository, "deploy/gateway/box");
  const { version } = JSON.parse(
    await readFile(join(box, "package.json"), "utf8"),
  );
  const image = testBoxImage(version, randomUUID());
  const work = await mkdtemp(join(tmpdir(), "agent-connect-verify-"));
  const env = { ...process.env, ACP_BOX_IMAGE: image };
  const options = { cwd: repository, env };
  const docker = (args, capture = false) =>
    run("docker", args, {
      ...options,
      capture,
      env: { ...env, DOCKER_CONFIG: join(work, "docker-config") },
    });
  try {
    await run(
      "./deploy/gateway/box/build-local.sh",
      ["--runners-only"],
      options,
    );
    const architecture = (
      await docker(["info", "--format", "{{.Architecture}}"], true)
    ).trim();
    const arch = {
      aarch64: "arm64",
      arm64: "arm64",
      x86_64: "amd64",
      amd64: "amd64",
    }[architecture];
    if (!arch)
      throw new Error(`Unsupported Docker architecture: ${architecture}`);
    const context = join(work, "box");
    await mkdir(context);
    for (const file of [
      "Dockerfile",
      "entrypoint.sh",
      "package.json",
      "package-lock.json",
    ])
      await copyFile(join(box, file), join(context, file));
    await copyFile(
      join(repository, "deploy/gateway/egress-proxy.mjs"),
      join(context, "egress-proxy.mjs"),
    );
    await copyFile(
      join(repository, "deploy/gateway/test/fixtures/codex-config.toml"),
      join(context, "mock-codex-config.toml"),
    );
    await copyFile(
      join(repository, `target/distrib/session-runner-linux-${arch}`),
      join(context, "session-runner"),
    );
    await docker([
      "build",
      "--platform",
      `linux/${arch}`,
      "--tag",
      image,
      context,
    ]);
    for (const step of [
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
    ])
      await run("npm", ["run", step], options);
  } finally {
    try {
      await removeTestImages(image, (args) => docker(args, true));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await verify();
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
