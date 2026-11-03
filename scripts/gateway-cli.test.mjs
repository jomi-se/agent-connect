import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ownerTerminal } from "../deploy/gateway/test/clean-room/owner-terminal.mjs";
import { gatewayTestBinary } from "./gateway-test-binary.mjs";
import { runCleanupTasks } from "./test-fixture-cleanup.mjs";
import { rootlessEnginePath } from "./rootless-engine-stub.mjs";

const binary = await gatewayTestBinary({
  repository: resolve(import.meta.dirname, ".."),
});
const suiteRoots = new Set();
const suiteChildren = new Set();
after(async () => {
  if (suiteChildren.size)
    throw new Error(
      "CLI child close was not confirmed; preserving suite temporary roots",
    );
  await runCleanupTasks(
    [...suiteRoots].map(
      (root) => () => rm(root, { recursive: true, force: true }),
    ),
  );
});
async function tempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  suiteRoots.add(root);
  return root;
}

const cliHome = await tempRoot("acp-cli-isolated-home-");
const cliState = join(cliHome, "state");
// setup refuses a rootful engine, so the CLI sees a rootless one. Awaited
// before the first test is registered: a top-level await after one lets the
// suite's after hook run before later tests allocate their roots.
const enginePath = await rootlessEnginePath(cliHome);
test("login invokes only the provider CLI with a private shared home and host UID", async () => {
  const root = await tempRoot("acp-login-command-");
  const home = join(root, "dedicated");
  await mkdir(join(root, "bin"));
  const docker = join(root, "bin/docker");
  await writeFile(
    docker,
    '#!/bin/sh\nif [ "$1" = info ]; then echo \'{"securityOptions":[],"operatingSystem":"Linux"}\'; exit 0; fi\nprintf "%s\\n" "$@" > "$LOGIN_ARGS"\n',
  );
  await chmod(docker, 0o755);
  for (const harness of ["codex", "claude"]) {
    const result = spawnSync(
      binary,
      ["login", "--harness", harness, "--harness-home", home],
      {
        encoding: "utf8",
        env: {
          PATH: join(root, "bin"),
          LOGIN_ARGS: join(root, "args"),
          ANTHROPIC_API_KEY: "must-not-enter-container",
          OPENAI_API_KEY: "must-not-enter-container",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const args = (await readFile(join(root, "args"), "utf8"))
      .trim()
      .split("\n");
    assert.ok(args.includes(`type=bind,src=${home},dst=/home/node`));
    assert.ok(args.includes(`${process.getuid()}:${process.getgid()}`));
    assert.ok(args.includes("-it"));
    assert.ok(
      !args.some(
        (arg) => arg.includes("API_KEY") || arg.includes("must-not-enter"),
      ),
    );
    assert.deepEqual(
      args.slice(harness === "codex" ? -3 : -2),
      harness === "codex"
        ? ["codex", "login", "--device-auth"]
        : ["claude", "/login"],
    );
  }
  await chmod(home, 0o755);
  const refused = spawnSync(
    binary,
    ["login", "--harness", "codex", "--harness-home", home],
    { encoding: "utf8" },
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /0700/);
});

test("help, version and invalid argument exit codes are stable", () => {
  assert.equal(spawnSync(binary, ["--help"]).status, 0);
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^agent-connect \d+\.\d+\.\d+/);
  const usage = spawnSync(binary, ["serve", "--unknown-option"], {
    encoding: "utf8",
  });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /unexpected argument/);
});

function cliEnv(env = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("AGENT_CONNECT_"),
    ),
  );
  return {
    ...inherited,
    PATH: enginePath,
    HOME: cliHome,
    XDG_STATE_HOME: cliState,
    ...env,
  };
}

function command(args, env = {}) {
  return spawnSync(binary, args, {
    timeout: 5000,
    encoding: "utf8",
    env: cliEnv(env),
  });
}

// A headless runtime is a configuration the operator writes; there is no
// command that creates one.
async function headlessRuntime() {
  const root = await tempRoot("acp-headless-");
  const directory = join(root, "runtime");
  await mkdir(join(directory, "state"), { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tools = join(directory, "tools.json");
  await writeFile(
    tools,
    JSON.stringify([{ name: "read", inputSchema: { type: "object" } }]),
    { mode: 0o600 },
  );
  const harnessHome = join(cliState, "agent-connect/harnesses/codex");
  await mkdir(harnessHome, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      harness: "codex",
      listen: "127.0.0.1:18940",
      headless_static_bearer: true,
      allow_origin: "https://app.example",
      token: "a".repeat(64),
      tools: "tools.json",
      harness_home: harnessHome,
      state_dir: "state",
      boxed: true,
      box_image: "session:test",
      egress_container: "agent-connect-egress-fixture",
    }),
    { mode: 0o600 },
  );
  return { root, tools, directory };
}

test("serve refuses unknown JSON fields and insecure config modes without printing token", async () => {
  const fixture = await headlessRuntime();
  const path = join(fixture.directory, "config.json");
  const configuration = JSON.parse(await readFile(path));
  await chmod(path, 0o644);
  const insecure = command(["serve", "--config", path]);
  assert.equal(insecure.status, 2);
  assert.match(insecure.stderr, /0600/);
  assert.ok(!insecure.stderr.includes(configuration.token));
  await chmod(path, 0o600);
  configuration.typo = true;
  await writeFile(path, JSON.stringify(configuration));
  const unknown = command(["serve", "--config", path]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown field/);
  assert.ok(!unknown.stderr.includes(configuration.token));
});

async function preflightDocker() {
  const root = await tempRoot("acp-preflight-cli-");
  const image = {
    Id: `sha256:${"d".repeat(64)}`,
    Config: { Env: [], User: "node" },
  };
  const container = {
    Id: "a".repeat(64),
    Image: image.Id,
    Config: {
      Env: [],
      Labels: { "org.agent-connect.component": "acp-egress" },
      Entrypoint: ["node"],
      Cmd: ["/opt/agent-connect/egress-proxy.mjs"],
      User: image.Config.User,
    },
    // Docker reports these even when unset (null or empty).
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd: null,
      Devices: [],
      DeviceRequests: null,
      PidMode: "",
      IpcMode: "private",
      NetworkMode: "bridge",
      Binds: null,
      PortBindings: {},
      SecurityOpt: ["no-new-privileges"],
      Memory: 268435456,
      NanoCpus: 1000000000,
      PidsLimit: 64,
      RestartPolicy: { Name: "unless-stopped" },
      LogConfig: {
        Type: "json-file",
        Config: { "max-size": "10m", "max-file": "3" },
      },
    },
    State: { Running: true, Restarting: false },
    Mounts: [],
  };
  await writeFile(join(root, "image"), JSON.stringify(image));
  await writeFile(join(root, "container"), JSON.stringify(container));
  await writeFile(
    join(root, "docker"),
    '#!/bin/sh\nif [ "$1" = info ]; then echo \'{"securityOptions":[],"operatingSystem":"Linux"}\'; exit 0; fi\nif [ "$1" = image ]; then /bin/cat "$PREFLIGHT_IMAGE"; elif [ "$1" = inspect ]; then /bin/cat "$PREFLIGHT_CONTAINER"; else exit 1; fi\n',
  );
  await chmod(join(root, "docker"), 0o755);
  return {
    PATH: root,
    PREFLIGHT_IMAGE: join(root, "image"),
    PREFLIGHT_CONTAINER: join(root, "container"),
  };
}

async function serveUntilReady(args, env = {}, cwd) {
  const { spawn } = await import("node:child_process");
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("AGENT_CONNECT_"),
    ),
  );
  const child = spawn(binary, args, {
    cwd,
    env: { ...inherited, HOME: cliHome, XDG_STATE_HOME: cliState, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  suiteChildren.add(child);
  let stderr = "";
  return await new Promise((resolveResult, reject) => {
    let failure;
    let stopping = false;
    let readyTimer;
    let escalation;
    let confirmation;
    const startup = setTimeout(() => {
      failure = new Error(`server startup timed out: ${stderr}`);
      stop();
    }, 5000);
    const clearTimers = () => {
      for (const timer of [startup, readyTimer, escalation, confirmation])
        clearTimeout(timer);
    };
    function stop() {
      if (stopping) return;
      stopping = true;
      clearTimeout(startup);
      clearTimeout(readyTimer);
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        child.kill("SIGKILL");
        confirmation = setTimeout(() => {
          clearTimers();
          // A failed signal or missing close must not turn cleanup into deletion
          // beneath a potentially live child. Let the suite fail without hanging.
          child.unref();
          child.stdout.destroy();
          child.stderr.destroy();
          reject(
            new Error(
              `server close was not confirmed; preserving temporary roots (pid ${child.pid})`,
            ),
          );
        }, 1000);
      }, 1000);
    }
    child.on("error", (error) => {
      failure = error;
      stop();
    });
    child.stderr.on("data", (data) => {
      stderr += data;
      if (stderr.includes("listening on") && !readyTimer && !stopping) {
        clearTimeout(startup);
        readyTimer = setTimeout(stop, 50);
      }
    });
    child.once("close", (code) => {
      suiteChildren.delete(child);
      clearTimers();
      if (failure) reject(failure);
      else resolveResult({ code, stderr });
    });
  });
}

test("CLI overrides environment, environment overrides JSON, and paths follow config directory", async () => {
  const fixture = await headlessRuntime();
  const path = join(fixture.directory, "config.json");
  const configuration = JSON.parse(await readFile(path));
  Object.assign(configuration, {
    boxed: false,
    mock_root: ".",
    harness_home: undefined,
    listen: "127.0.0.1:1",
  });
  await writeFile(path, JSON.stringify(configuration));
  const fromEnv = await serveUntilReady(
    ["serve", "--config", path],
    { AGENT_CONNECT_LISTEN: "127.0.0.1:0" },
    tmpdir(),
  );
  assert.equal(fromEnv.code, 0, fromEnv.stderr);
  assert.match(fromEnv.stderr, /ws:\/\/127\.0\.0\.1:0\/acp/);
  const fromCli = await serveUntilReady(
    ["serve", "--config", path, "--listen", "127.0.0.1:0"],
    { AGENT_CONNECT_LISTEN: "127.0.0.1:1" },
    tmpdir(),
  );
  assert.equal(fromCli.code, 0, fromCli.stderr);
  assert.match(fromCli.stderr, /ws:\/\/127\.0\.0\.1:0\/acp/);
  const fromConfig = await serveUntilReady(
    ["serve"],
    {
      AGENT_CONNECT_CONFIG: path,
      AGENT_CONNECT_LISTEN: "127.0.0.1:0",
      AGENT_CONNECT_BOXED: "false",
    },
    tmpdir(),
  );
  assert.equal(fromConfig.code, 0, fromConfig.stderr);
});

test("production isolation requirements and runtime failures have distinct exits", async () => {
  const fixture = await headlessRuntime();
  const base = [
    "serve",
    "--harness",
    "codex",
    "--allow-origin",
    "https://app.example",
    "--headless-static-bearer",
    "--token",
    "fixture",
    "--tools",
    fixture.tools,
  ];
  assert.equal(command(base).status, 2);
  assert.equal(command([...base, "--boxed"]).status, 2);
  const defaultHome = await serveUntilReady(
    [
      ...base,
      "--boxed",
      "--egress-container",
      "egress",
      "--listen",
      "127.0.0.1:0",
    ],
    await preflightDocker(),
  );
  assert.equal(defaultHome.code, 0, defaultHome.stderr);
  const runtime = command([
    ...base.slice(0, -1),
    join(fixture.root, "missing.json"),
    "--mock-root",
    fixture.root,
  ]);
  // A missing operator input file is an I/O failure rather than a schema failure.
  assert.equal(runtime.status, 1);
});

test("relative config argument resolves a dedicated production home to an absolute path", async () => {
  const fixture = await headlessRuntime();
  const result = await serveUntilReady(
    ["serve", "--config", "runtime/config.json", "--listen", "127.0.0.1:0"],
    await preflightDocker(),
    fixture.root,
  );
  assert.equal(result.code, 0, result.stderr);
});

test("flagless login refuses nonterminal input without allocating a home", async () => {
  const { access } = await import("node:fs/promises");
  const state = join(await tempRoot("acp-no-tty-"), "state");
  const result = command(["login"], { XDG_STATE_HOME: state });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /needs a terminal.*--harness codex/);
  await assert.rejects(access(state), { code: "ENOENT" });
});

test("login defaults to the platform harness home; a config's home and box apply", async () => {
  const root = await tempRoot("acp-login-defaults-");
  await mkdir(join(root, "bin"));
  await writeFile(
    join(root, "bin/docker"),
    '#!/bin/sh\nif [ "$1" = info ]; then echo \'{"securityOptions":[],"operatingSystem":"Linux"}\'; exit 0; fi\nprintf "%s\\n" "$@" > "$LOGIN_ARGS"\n',
  );
  await chmod(join(root, "bin/docker"), 0o755);
  const env = { PATH: join(root, "bin"), LOGIN_ARGS: join(root, "args") };
  assert.equal(command(["login", "--harness", "codex"], env).status, 0);
  const fixture = await headlessRuntime();
  const path = join(fixture.directory, "config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  const args = (await readFile(env.LOGIN_ARGS, "utf8")).split("\n");
  assert.ok(
    args.includes(`type=bind,src=${config.harness_home},dst=/home/node`),
  );
  // A config may name a relative, per-runtime home and its own box.
  config.harness_home = "legacy-home";
  config.box_image = "session:legacy-test";
  await writeFile(path, JSON.stringify(config));
  const configured = command(
    ["login", "--harness", "codex", "--config", path],
    env,
  );
  assert.equal(configured.status, 0, configured.stderr);
  const legacy = await readFile(env.LOGIN_ARGS, "utf8");
  assert.ok(
    legacy.includes(
      `type=bind,src=${join(fixture.directory, "legacy-home")},dst=/home/node`,
    ),
  );
  assert.ok(legacy.includes("session:legacy-test"));
  const overridden = command(
    [
      "login",
      "--harness",
      "codex",
      "--config",
      path,
      "--harness-home",
      join(root, "override"),
      "--box-image",
      "session:override",
    ],
    env,
  );
  assert.equal(overridden.status, 0, overridden.stderr);
  const override = await readFile(env.LOGIN_ARGS, "utf8");
  assert.ok(
    override.includes(`type=bind,src=${join(root, "override")},dst=/home/node`),
  );
  assert.ok(override.includes("session:override"));
  const mismatch = command(
    ["login", "--harness", "claude", "--config", path],
    env,
  );
  assert.equal(mismatch.status, 2);
  assert.match(mismatch.stderr, /does not match/);
  assert.equal(await readFile(env.LOGIN_ARGS, "utf8"), override);
  // Login needs no bearer, origin, proxy or server isolation configuration.
  await writeFile(
    path,
    JSON.stringify({
      harness: "codex",
      harness_home: "legacy-home",
      box_image: "session:legacy-test",
    }),
  );
  const loginOnly = command(["login", "--harness", "codex", "--config", path], {
    ...env,
    AGENT_CONNECT_TOKEN: "fixture-supplied-at-serve-time",
  });
  assert.equal(loginOnly.status, 0, loginOnly.stderr);
  const loginArgs = await readFile(env.LOGIN_ARGS, "utf8");
  assert.ok(
    loginArgs.includes(
      `type=bind,src=${join(fixture.directory, "legacy-home")},dst=/home/node`,
    ),
  );
  assert.ok(!loginArgs.includes("fixture-supplied-at-serve-time"));
  // With no --config, the default runtime's box is the one signed into.
  const defaultRuntime = join(cliState, "agent-connect/runtime");
  await mkdir(defaultRuntime, { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      join(defaultRuntime, "config.json"),
      JSON.stringify({
        harness: "codex",
        box_image: "session:default-runtime",
      }),
      { mode: 0o600 },
    );
    const bare = command(["login", "--harness", "codex"], env);
    assert.equal(bare.status, 0, bare.stderr);
    assert.ok(
      (await readFile(env.LOGIN_ARGS, "utf8")).includes(
        "session:default-runtime",
      ),
    );
    const other = command(["login", "--harness", "claude"], env);
    assert.equal(other.status, 2);
    assert.match(other.stderr, /runtime's configuration/);
  } finally {
    await rm(defaultRuntime, { recursive: true, force: true });
  }
});

test(
  "agent-connect login offers a real terminal selector before invoking the chosen provider",
  { skip: process.platform !== "linux" },
  async () => {
    for (const [input, harness] of [
      ["\n", "codex"],
      ["wrong\n2\n", "claude"],
      ["q\n", null],
    ]) {
      const root = await tempRoot("acp-selector-");
      await mkdir(join(root, "bin"));
      // Rootless, so the gateway prefers this Docker over a host's Podman.
      await writeFile(
        join(root, "bin/docker"),
        '#!/bin/sh\nif [ "$1" = info ]; then echo \'{"securityOptions":["name=rootless"],"operatingSystem":"Linux"}\'; exit 0; fi\nprintf "%s\\n" "$@" > "$LOGIN_ARGS"\n',
      );
      await chmod(join(root, "bin/docker"), 0o755);
      const env = {
        ...process.env,
        HOME: root,
        XDG_STATE_HOME: join(root, "state"),
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        LOGIN_ARGS: join(root, "args"),
      };
      for (const name of Object.keys(env))
        if (name.startsWith("AGENT_CONNECT_")) delete env[name];
      const canonical = binary;
      const result = spawnSync(
        "/usr/bin/script",
        [
          "-q",
          "-e",
          "-c",
          `'${canonical.replaceAll("'", "'\\''")}' login`,
          "/dev/null",
        ],
        { input, encoding: "utf8", timeout: 10000, env },
      );
      assert.equal(
        result.status,
        0,
        `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
      );
      assert.match(result.stdout, /Choose a harness/);
      assert.match(
        result.stdout,
        /Claude Code \(unconfirmed against Anthropic terms\)/,
      );
      if (harness) {
        const args = await readFile(env.LOGIN_ARGS, "utf8");
        assert.ok(
          args.includes(
            `type=bind,src=${join(root, "state/agent-connect/harnesses", harness)},dst=/home/node`,
          ),
        );
        assert.ok(
          args.includes(
            harness === "codex"
              ? "codex\nlogin\n--device-auth"
              : "claude\n/login",
          ),
        );
      } else {
        const { access } = await import("node:fs/promises");
        await assert.rejects(access(env.LOGIN_ARGS), { code: "ENOENT" });
        await assert.rejects(access(join(root, "state")), { code: "ENOENT" });
      }
    }
  },
);

function ownerSetup(directory, ...extra) {
  // The fixture box stands in for the one setup would build.
  return [
    "setup",
    "--apply",
    "--non-interactive",
    "--no-service",
    "--box-image",
    "session:test",
    "--directory",
    directory,
    "--harness",
    "codex",
    ...extra,
  ];
}

test("owner setup enrolls owner auth without issuing an app bearer", async () => {
  const { stat } = await import("node:fs/promises");
  const root = await tempRoot("acp-owner-setup-");
  const directory = join(root, "runtime");
  const result = await ownerTerminal(
    binary,
    ownerSetup(directory, "--origin", "https://gateway.example"),
    "isolated-owner-test-passphrase",
    { env: cliEnv() },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.answered, 2, "setup asks for the passphrase twice");
  assert.match(
    result.stdout,
    /https:\/\/gateway\.example\/agent-connect\/owner/,
  );
  assert.ok(!result.stdout.includes("isolated-owner-test-passphrase"));
  const config = JSON.parse(await readFile(join(directory, "config.json")));
  assert.equal(config.public_url, "https://gateway.example");
  assert.equal(config.headless_static_bearer, undefined);
  assert.equal(config.container_engine, "docker");
  assert.match(config.egress_container, /^agent-connect-egress-[0-9a-f]{12}$/);
  assert.equal(config.token, undefined);
  assert.equal(config.tools, undefined);
  assert.equal(config.allow_origin, undefined);
  await assert.rejects(stat(join(directory, "grant.json")), { code: "ENOENT" });
  const state = await readFile(
    join(directory, "state/auth/authorization.json"),
    "utf8",
  );
  assert.ok(!state.includes("isolated-owner-test-passphrase"));
  assert.equal(
    (await stat(join(directory, "state/auth/authorization.json"))).mode & 0o777,
    0o600,
  );
  Object.assign(config, {
    boxed: false,
    mock_root: root,
    harness_home: undefined,
  });
  await writeFile(join(directory, "config.json"), JSON.stringify(config));
  const serving = await serveUntilReady([
    "serve",
    "--config",
    join(directory, "config.json"),
    "--listen",
    "127.0.0.1:0",
  ]);
  assert.equal(serving.code, 0, serving.stderr);
});

test("owner setup rejects unattended prompts and invalid public origins before creation", async () => {
  const { stat } = await import("node:fs/promises");
  const root = await tempRoot("acp-owner-invalid-");
  const directory = join(root, "runtime");
  const noTerminal = command(ownerSetup(directory));
  assert.equal(noTerminal.status, 2, noTerminal.stderr);
  assert.match(noTerminal.stderr, /needs the owner at a terminal/);
  for (const url of [
    "http://gateway.example",
    "https://gateway.example/path",
    "https://owner@gateway.example",
    "https://gateway.example?secret=x",
  ]) {
    assert.equal(command(ownerSetup(directory, "--origin", url)).status, 2);
  }
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("owner setup rejects runtime inside harness mount, including canonical aliases", async () => {
  const { symlink, stat } = await import("node:fs/promises");
  const root = await tempRoot("acp-owner-boundary-");
  const home = join(root, "harness");
  await mkdir(home, { mode: 0o700 });
  const alias = join(root, "alias");
  await symlink(home, alias);
  for (const parent of [home, alias]) {
    const runtime = join(parent, "runtime");
    const result = await ownerTerminal(
      binary,
      ownerSetup(runtime, "--harness-home", home),
      "isolated-owner-test-passphrase",
      { env: cliEnv() },
    );
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /outside the mounted harness home/);
    await assert.rejects(stat(runtime), { code: "ENOENT" });
  }
});

test("serve rejects owner state or config inside harness mount before Docker startup", async () => {
  const root = await tempRoot("acp-serve-owner-boundary-");
  const home = join(root, "harness");
  await mkdir(home, { mode: 0o700 });
  const outside = join(root, "config.json");
  const configuration = {
    harness: "codex",
    public_url: "https://gateway.example",
    boxed: true,
    harness_home: home,
    box_image: "session:test",
    egress_container: "owned-egress",
    state_dir: join(home, "authstate"),
  };
  await writeFile(outside, JSON.stringify(configuration), { mode: 0o600 });
  let result = command(["serve", "--config", outside]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /outside the mounted harness home/);
  configuration.state_dir = join(root, "safe-state");
  const inside = join(home, "config.json");
  await writeFile(inside, JSON.stringify(configuration), { mode: 0o600 });
  result = command(["serve", "--config", inside]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /outside the mounted harness home/);
});

test("boxed Codex rejects ineffective permission profiles and arbitrary modes", () => {
  const args = [
    "serve",
    "--harness",
    "codex",
    "--boxed",
    "--public-url",
    "https://gateway.example",
    "--egress-container",
    "owned-egress",
  ];
  for (const profile of ["deny-all", "app-tools-only"]) {
    const result = command([...args, "--permissions", profile]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /boxed Codex supports only/);
  }
  const invalidMode = command([...args, "--codex-mode", "invented"]);
  assert.equal(invalidMode.status, 2);
  assert.match(invalidMode.stderr, /invalid value/);
});
