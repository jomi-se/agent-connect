// Real Docker setup using only packed npm inputs, isolated owner state and no login.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { testBoxImage, removeTestImages } from "./test-box-images.mjs";
import { ownerTerminal } from "../deploy/gateway/test/clean-room/owner-terminal.mjs";
const artifacts = resolve(process.argv[2] ?? "dist/release");
const release = JSON.parse(
  await readFile(join(artifacts, "release.json"), "utf8"),
);
const root = await mkdtemp(join(tmpdir(), "agent-connect-box-acceptance-"));
const base = testBoxImage(release.version, randomUUID());
const env = {
  PATH: process.env.PATH,
  HOME: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  npm_config_cache: join(root, "npm-cache"),
  AGENT_CONNECT_TEST_BOX_IMAGE: base,
};
const egress = `box-acceptance-${root.split("-").at(-1).toLowerCase()}`;
const gateway = join(root, "node_modules/.bin/agent-connect");
function run(bin, args, { allowFailure = false, extraEnv = {} } = {}) {
  const result = spawnSync(bin, args, {
    cwd: root,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error && !allowFailure) throw result.error;
  if (!allowFailure && result.status !== 0)
    throw new Error(
      `${bin} failed (${result.status})\n${result.stdout}${result.stderr}`,
    );
  return result;
}
function inspect(image) {
  return run("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    image,
  ]).stdout.trim();
}
const setupArgs = [
  "setup",
  "--apply",
  "--non-interactive",
  "--json",
  "--no-service",
  "--egress-container",
  egress,
];
const passphrase = "synthetic-box-test-passphrase";
// First-time setup prompts for the owner passphrase, so setup runs on a terminal.
async function terminalSetup(extraEnv = {}) {
  return ownerTerminal(gateway, setupArgs, passphrase, {
    cwd: root,
    env: { ...env, ...extraEnv },
  });
}
async function setup() {
  const result = await terminalSetup();
  if (result.code !== 0)
    throw new Error(
      `setup failed (${result.code})\n${result.stdout}${result.stderr}`,
    );
  return { plan: JSON.parse(result.stdout), stderr: result.stderr };
}
function doctor() {
  return JSON.parse(
    run(gateway, ["doctor", "--json"], { allowFailure: true }).stdout,
  );
}
try {
  await writeFile(join(root, "package.json"), '{"private":true}');
  run("npm", [
    "install",
    "--ignore-scripts",
    "--omit=optional",
    "--no-audit",
    "--no-fund",
    join(artifacts, `open-agent-connect-gateway-${release.version}.tgz`),
    join(
      artifacts,
      `open-agent-connect-gateway-linux-${process.arch}-${release.version}.tgz`,
    ),
  ]);
  // Old packed binaries must fail before applying setup or building a live tag.
  assert.equal(
    JSON.parse(
      run(
        gateway,
        setupArgs.filter((arg) => arg !== "--apply"),
      ).stdout,
    ).boxImage,
    base,
    "Packed gateway must support isolated test box builds; rebuild the artifacts",
  );
  const initial = await setup();
  assert.equal(initial.plan.boxImage, base);
  const baseId = inspect(base);
  run("docker", [
    "run",
    "--pull=never",
    "--rm",
    "--network",
    "none",
    base,
    "sh",
    "-ec",
    'for tool in bash cat sed grep gawk git rg fd jq curl python3 less ps unzip node; do command -v "$tool"; done; test -f /etc/ssl/certs/ca-certificates.crt; test "$(find /opt/adapters/node_modules/@anthropic-ai -type f \\( -name claude -o -name claude.exe \\) | wc -l)" = 1; test -x "$CLAUDE_CODE_EXECUTABLE"; test -z "$(find /opt/adapters -name codex-voice-host -o -name codex-code-mode-host)"; codex --version; claude --version',
  ]);
  const unchanged = await setup();
  assert.match(unchanged.stderr, /Reusing local box/);
  assert.equal(inspect(base), baseId);
  const configBefore = await readFile(initial.plan.config);
  const ownerBefore = await readFile(
    join(initial.plan.directory, "state/auth/authorization.json"),
  );
  const layer = join(env.XDG_CONFIG_HOME, "agent-connect/box");
  await mkdir(layer, { recursive: true });
  // A unique marker makes image ownership unambiguous without removing another owner's tag.
  await writeFile(join(layer, "marker"), root.split("-").at(-1));
  await writeFile(
    join(layer, "Dockerfile"),
    "COPY marker /opt/owner-marker\nRUN printf first > /opt/owner-tool\nWORKDIR /tmp\n",
  );
  assert.equal(
    doctor().checks.find((check) => check.code === "box_current").status,
    "warn",
  );
  const first = (await setup()).plan;
  assert.match(
    first.boxImage,
    new RegExp(`^${base.replaceAll(".", "\\.")}-[a-f0-9]{16}$`),
  );
  const metadata = JSON.parse(
    run("docker", ["image", "inspect", first.boxImage]).stdout,
  )[0].Config;
  assert.equal(metadata.User, "node");
  assert.equal(metadata.WorkingDir, "/work");
  assert.deepEqual(metadata.Entrypoint, ["/usr/local/bin/entrypoint.sh"]);
  assert.equal(
    run("docker", [
      "run",
      "--pull=never",
      "--rm",
      "--network",
      "none",
      first.boxImage,
      "cat",
      "/opt/owner-tool",
    ]).stdout,
    "first",
  );
  assert.match((await setup()).stderr, /Reusing local box/);
  await writeFile(join(layer, "marker"), "changed-" + root.split("-").at(-1));
  assert.equal(
    doctor().checks.find((check) => check.code === "box_current").status,
    "warn",
  );
  const changed = (await setup()).plan;
  assert.notEqual(changed.boxImage, first.boxImage);
  assert.equal(
    doctor().checks.find((check) => check.code === "box_current").status,
    "pass",
  );
  const goodConfig = await readFile(changed.config);
  await writeFile(
    join(layer, "Dockerfile"),
    "RUN echo intentional-build-failure >&2; exit 23\n",
  );
  const fallback = await setup();
  assert.equal(fallback.plan.boxImage, changed.boxImage);
  assert.match(fallback.stderr, /intentional-build-failure/);
  assert.match(fallback.stderr, /Keeping previously built box/);
  assert.deepEqual(await readFile(changed.config), goodConfig);
  assert.equal(
    doctor().checks.find((check) => check.code === "box_current").status,
    "warn",
  );
  const freshState = join(root, "fresh-state");
  const failedInstall = await terminalSetup({ XDG_STATE_HOME: freshState });
  assert.equal(failedInstall.code, 1);
  assert.match(failedInstall.stderr, /intentional-build-failure/);
  await assert.rejects(stat(freshState), { code: "ENOENT" });
  await rm(layer, { recursive: true });
  assert.equal((await setup()).plan.boxImage, base);
  assert.deepEqual(await readFile(initial.plan.config), configBefore);
  assert.deepEqual(
    await readFile(
      join(initial.plan.directory, "state/auth/authorization.json"),
    ),
    ownerBefore,
  );
  assert.equal(inspect(base), baseId);
  console.log(
    "Packed Linux setup: base tools, one Claude binary, local build/reuse, layer build/content rebuild/removal, doctor and failed-build fallback passed.",
  );
} finally {
  try {
    run(gateway, ["egress", "stop", "--name", egress], { allowFailure: true });
    await removeTestImages(base, async (args) => run("docker", args).stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
