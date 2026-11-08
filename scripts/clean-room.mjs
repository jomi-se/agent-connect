// Local acceptance only. Fresh test container receives artifacts, never a checkout.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readdir,
  copyFile,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pruneTestInstallations } from "./test-fixture-cleanup.mjs";
import { testBoxImage, removeTestImages } from "./test-box-images.mjs";
import { cleanupSessionResources } from "./clean-room-resources.mjs";
const repo = resolve(import.meta.dirname, "..");
const artifactDirectory = resolve(
  process.env.AGENT_CONNECT_RELEASE_DIR ??
    process.argv[2] ??
    join(repo, "dist/release"),
);
const kit = join(repo, "deploy/gateway/test/clean-room");
const run = await mkdtemp(join(tmpdir(), "acp-clean-room-"));
const suffix = randomUUID().replaceAll("-", "");
const name = `acp-clean-room-${suffix}`;
const image = `agent-connect-clean-room-test:0.0.1-${suffix}`;
let boxImage;
let createdImageId;
const children = new Set();
async function command(binary, args, options = {}) {
  const child = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
    env:
      binary === "docker"
        ? { ...process.env, DOCKER_CONFIG: join(run, "docker-config") }
        : process.env,
  });
  children.add(child);
  let tail = "";
  const output = (bytes) => {
    tail = (tail + bytes).slice(-8000);
    if (options.inherit) process.stdout.write(bytes);
  };
  child.stdout.on("data", output);
  child.stderr.on("data", output);
  return await new Promise((ok, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => {
      children.delete(child);
      code === 0
        ? ok(tail)
        : fail(new Error(`${binary} exited ${code}\n${tail}`));
    });
  });
}
let cleaning;
function cleanup() {
  return (cleaning ??= (async () => {
    await command("docker", ["rm", "-f", name]).catch(() => {});
    const failures = [];
    // The driver records only resources created by this run, for host-side recovery.
    const ownership = await readFile(join(run, "work/resources.json"), "utf8")
      .then(JSON.parse)
      .catch(() => ({}));
    // Setup names the gateway's proxy after the run's runtime directory.
    const egress = (ownership.containers ?? []).find((container) =>
      container.startsWith("agent-connect-egress-"),
    );
    // Recover hosts from this run's private state even if their peers detached.
    const ids = (
      await readdir(join(run, "work/operator/state/sessions")).catch(() => [])
    ).filter((id) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id));
    await cleanupSessionResources({
      sessionIds: ids,
      model: `acp-clean-model-${suffix}`,
      egress,
      docker: (args) => command("docker", args),
    }).catch((error) => failures.push(error));
    for (const container of ownership.containers ?? []) {
      if (container === `acp-clean-model-${suffix}` || container === egress)
        await command("docker", ["rm", "-f", container]).catch(() => {});
    }
    for (const network of ownership.networks ?? []) {
      if (network === `acp-clean-model-${suffix}-base`)
        await command("docker", ["network", "rm", network]).catch(() => {});
    }
    for (const child of children) child.kill("SIGTERM");
    // Attempt every owned tag, including builds that failed before ID capture.
    for (const base of [image, boxImage].filter(Boolean))
      await removeTestImages(base, (args) => command("docker", args)).catch(
        (error) => failures.push(error),
      );
    if (failures.length)
      throw new AggregateError(failures, "Clean-room resource cleanup failed");
  })());
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void cleanup()
      .catch((error) => console.error(error))
      .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
try {
  const manifest = JSON.parse(
    await readFile(join(artifactDirectory, "release.json"), "utf8"),
  );
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i);
  assert.ok(
    manifest.artifacts && typeof manifest.artifacts === "object",
    "Release artifact checksums are required",
  );
  for (const [filename, expected] of Object.entries(manifest.artifacts)) {
    assert.match(
      filename,
      /^[a-z0-9][a-z0-9._-]*$/i,
      "Release artifact filenames must be plain filenames",
    );
    const bytes = await readFile(join(artifactDirectory, filename));
    assert.equal(
      bytes.length,
      expected.size,
      `${filename}: release size mismatch`,
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected.sha256,
      `${filename}: release checksum mismatch`,
    );
  }
  await mkdir(join(run, "artifacts"));
  await mkdir(join(run, "context"));
  await mkdir(join(run, "work"), { mode: 0o700 });
  const files = (await readdir(artifactDirectory)).filter((file) =>
    file.endsWith(".tgz"),
  );
  if (!files.includes("acp-chat-sample.tgz"))
    throw new Error(
      "Missing acp-chat-sample.tgz; prepare the local release artifacts first",
    );
  for (const file of ["release.json", ...files])
    await copyFile(join(artifactDirectory, file), join(run, "artifacts", file));
  // The driver runs the Playwright the repository locks, so a Playwright bump
  // at the root moves the clean room with it.
  const lock = JSON.parse(
    await readFile(join(repo, "package-lock.json"), "utf8"),
  );
  const playwright = lock.packages?.["node_modules/playwright"]?.version;
  if (!playwright) throw new Error("package-lock.json locks no playwright");
  await writeFile(
    join(run, "context", "package.json"),
    `${JSON.stringify(
      {
        name: "agent-connect-clean-room-driver",
        private: true,
        type: "module",
        dependencies: { playwright },
      },
      null,
      2,
    )}\n`,
  );
  for (const file of [
    "Dockerfile",
    "run.mjs",
    "relay.mjs",
    "owner-terminal.mjs",
  ])
    await copyFile(join(kit, file), join(run, "context", file));
  await copyFile(
    join(repo, "deploy/gateway/test/fixtures/mock-model/server.mjs"),
    join(run, "context/mock-model.mjs"),
  );
  for (const file of ["codex-config.toml", "seed-codex.mjs"])
    await copyFile(
      join(repo, "deploy/gateway/test/fixtures", file),
      join(run, "context", file),
    );
  boxImage = testBoxImage(manifest.version, suffix);
  await command("docker", ["build", "-t", image, join(run, "context")]);
  createdImageId = (
    await command("docker", ["image", "inspect", "--format", "{{.Id}}", image])
  ).trim();
  assert.match(createdImageId, /^sha256:[0-9a-f]{64}$/);
  const socket = process.env.ACP_DOCKER_SOCKET ?? "/var/run/docker.sock";
  // Read the mounted socket in Docker's namespace: a sandbox may map its GID
  // to nobody even though the actual socket has a different owning group.
  const socketGroup = (
    await command("docker", [
      "run",
      "--pull=never",
      "--rm",
      "--network",
      "none",
      "--mount",
      `type=bind,src=${socket},dst=/var/run/docker.sock`,
      "--entrypoint",
      "stat",
      createdImageId,
      "-c",
      "%g",
      "/var/run/docker.sock",
    ])
  ).trim();
  assert.match(socketGroup, /^\d+$/);
  const uid = process.getuid();
  const gid = process.getgid();
  await writeFile(
    join(run, "work/resources.json"),
    JSON.stringify({ containers: [] }),
    { mode: 0o600 },
  );
  await command(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      name,
      "--user",
      `${uid}:${gid}`,
      "--group-add",
      socketGroup,
      "--mount",
      `type=bind,src=${join(run, "artifacts")},dst=/artifacts,readonly`,
      "--mount",
      `type=bind,src=${join(run, "work")},dst=${join(run, "work")}`,
      "--mount",
      `type=bind,src=${socket},dst=/var/run/docker.sock`,
      "-e",
      `ACP_CLEAN_WORK=${join(run, "work")}`,
      "-e",
      `ACP_CLEAN_SUFFIX=${suffix}`,
      "-e",
      `ACP_BOX_IMAGE=${boxImage}`,
      "-e",
      `AGENT_CONNECT_TEST_BOX_IMAGE=${boxImage}`,
      "-e",
      `HOME=${join(run, "work")}`,
      "-e",
      `XDG_STATE_HOME=${join(run, "work/state-home")}`,
      "-e",
      `XDG_CONFIG_HOME=${join(run, "work/config-home")}`,
      createdImageId,
    ],
    { inherit: true },
  );
  const report = JSON.parse(
    await readFile(join(run, "work/report.json"), "utf8"),
  );
  assert.equal(report.status, "passed");
  assert.ok(
    report.checks.length >= 25,
    "baseline pairing/chat/tool/reconnect/cancel gates and operation parity gates must all run",
  );
  for (const capability of [
    "setup-plan",
    "setup-apply",
    "doctor-json",
    "service-offline",
    "profile-readonly",
    "sample-auto-recovery",
    "sessions-end",
    "logout",
    "revoke-all",
    "runtime-problem",
  ])
    assert.ok(
      report.parityCoverage?.includes(capability),
      `missing artifact acceptance: ${capability}`,
    );
  console.log(
    `PASS ACP clean-room acceptance (diagnostics: ${run}/work/report.json)`,
  );
} finally {
  try {
    await cleanup();
  } finally {
    await pruneTestInstallations(run);
    console.log(`ACP clean-room diagnostics: ${run}/work/report.json`);
  }
}
