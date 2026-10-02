import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const cliHome = await mkdtemp(join(tmpdir(), "acp-cli-isolated-home-"));
const cliState = join(cliHome, "state");
const binary = resolve(
  import.meta.dirname,
  "../target/debug/agent-connect-gateway",
);
test("login invokes only the provider CLI with a private shared home and host UID", async () => {
  const root = await mkdtemp(join(tmpdir(), "acp-login-command-"));
  const home = join(root, "dedicated");
  await mkdir(join(root, "bin"));
  const docker = join(root, "bin/docker");
  await writeFile(docker, '#!/bin/sh\nprintf "%s\\n" "$@" > "$LOGIN_ARGS"\n');
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
  assert.match(version.stdout, /0\.1\.0-alpha\.1/);
  const usage = spawnSync(binary, ["serve", "--unknown-option"], {
    encoding: "utf8",
  });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /unexpected argument/);
});

function command(args, env = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("AGENT_CONNECT_"),
    ),
  );
  return spawnSync(binary, args, {
    timeout: 5000,
    encoding: "utf8",
    env: { ...inherited, HOME: cliHome, XDG_STATE_HOME: cliState, ...env },
  });
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "acp-init-"));
  const tools = join(root, "input-tools.json");
  await writeFile(
    tools,
    JSON.stringify([{ name: "read", inputSchema: { type: "object" } }]),
  );
  const directory = join(root, "runtime");
  const args = [
    "init",
    "--directory",
    directory,
    "--harness",
    "codex",
    "--allow-origin",
    "https://app.example",
    "--tools",
    tools,
  ];
  return { root, tools, directory, args };
}

test("init validates first, creates private scoped grant, and refuses overwrites", async () => {
  const { stat } = await import("node:fs/promises");
  const fixture = await setup();
  const result = command(fixture.args);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(
    await readFile(join(fixture.directory, "config.json")),
  );
  const grant = JSON.parse(
    await readFile(join(fixture.directory, "grant.json")),
  );
  assert.deepEqual(Object.keys(grant).sort(), ["gatewayUrl", "token"]);
  assert.equal(grant.gatewayUrl, "ws://127.0.0.1:18940/acp");
  assert.equal(grant.token, config.token);
  assert.match(grant.token, /^[a-f0-9]{64}$/);
  assert.equal(config.allow_origin, "https://app.example");
  assert.equal(config.boxed, true);
  assert.equal(
    config.harness_home,
    join(cliState, "agent-connect/harnesses/codex"),
  );
  assert.equal(config.tools, "tools.json");
  assert.ok(!result.stdout.includes(grant.token));
  assert.match(result.stdout, /egress start/);
  assert.match(result.stdout, /Next: agent-connect login \(choose Codex\)/);
  assert.match(result.stdout, /serve --config/);
  assert.equal((await stat(config.harness_home)).mode & 0o777, 0o700);
  for (const name of ["", "state"]) {
    assert.equal(
      (await stat(join(fixture.directory, name))).mode & 0o777,
      0o700,
    );
  }
  for (const name of ["config.json", "grant.json", "tools.json"]) {
    assert.equal(
      (await stat(join(fixture.directory, name))).mode & 0o777,
      0o600,
    );
  }
  const refused = command(fixture.args);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /must not exist/);
  assert.equal(
    JSON.parse(await readFile(join(fixture.directory, "grant.json"))).token,
    grant.token,
  );
  const second = await setup();
  assert.equal(command(second.args).status, 0);
  assert.notEqual(
    JSON.parse(await readFile(join(second.directory, "grant.json"))).token,
    grant.token,
  );
});

test("init rejects invalid snapshot and origin before creating runtime files", async () => {
  const { stat } = await import("node:fs/promises");
  const fixture = await setup();
  for (const tools of [
    [{ name: "missing-schema" }],
    [
      { name: "duplicate", inputSchema: {} },
      { name: "duplicate", inputSchema: {} },
    ],
  ]) {
    await writeFile(fixture.tools, JSON.stringify(tools));
    const refused = command(fixture.args);
    assert.equal(refused.status, 2);
    await assert.rejects(stat(fixture.directory), { code: "ENOENT" });
  }
  await writeFile(fixture.tools, "[]");
  const args = [...fixture.args];
  args[args.indexOf("--allow-origin") + 1] = "https://app.example/path";
  assert.equal(command(args).status, 2);
  await assert.rejects(stat(fixture.directory), { code: "ENOENT" });
});

test("serve refuses unknown JSON fields and insecure config modes without printing token", async () => {
  const fixture = await setup();
  assert.equal(command(fixture.args).status, 0);
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
  let stderr = "";
  return await new Promise((resolveResult, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server startup timed out: ${stderr}`));
    }, 5000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stderr.on("data", (data) => {
      stderr += data;
      if (stderr.includes("listening on"))
        setTimeout(() => child.kill("SIGTERM"), 50);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolveResult({ code, stderr });
    });
  });
}

test("CLI overrides environment, environment overrides JSON, and paths follow config directory", async () => {
  const fixture = await setup();
  assert.equal(command(fixture.args).status, 0);
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
  const fixture = await setup();
  const base = [
    "serve",
    "--harness",
    "codex",
    "--allow-origin",
    "https://app.example",
    "--token",
    "fixture",
    "--tools",
    fixture.tools,
  ];
  assert.equal(command(base).status, 2);
  assert.equal(command([...base, "--boxed"]).status, 2);
  const defaultHome = await serveUntilReady([
    ...base,
    "--boxed",
    "--egress-container",
    "egress",
    "--listen",
    "127.0.0.1:0",
  ]);
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

test("egress uses read-only same-image proxy and verifies ownership before deleting immutable ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "acp-egress-command-"));
  await mkdir(join(root, "bin"));
  const docker = join(root, "bin/docker");
  await writeFile(
    docker,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$DOCKER_ARGS"\nif [ "$1" = inspect ]; then /bin/cat "$DOCKER_INSPECT"; fi\n',
  );
  await chmod(docker, 0o755);
  const env = {
    PATH: join(root, "bin"),
    DOCKER_ARGS: join(root, "args"),
    DOCKER_INSPECT: join(root, "inspect.json"),
    OPENAI_API_KEY: "never-forward",
    ANTHROPIC_API_KEY: "never-forward",
  };
  const start = command(
    [
      "egress",
      "start",
      "--name",
      "owned-egress",
      "--session-image",
      "session:test",
    ],
    env,
  );
  assert.equal(start.status, 0, start.stderr);
  let args = (await readFile(env.DOCKER_ARGS, "utf8")).trim().split("\n");
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("org.agent-connect.component=acp-egress"));
  assert.ok(
    !args.some(
      (arg) =>
        arg === "-p" ||
        arg.includes("publish") ||
        arg.includes("API_KEY") ||
        arg.includes("never-forward"),
    ),
  );
  assert.deepEqual(args.slice(-4), [
    "--entrypoint",
    "node",
    "session:test",
    "/opt/agent-connect/egress-proxy.mjs",
  ]);
  const id = "a".repeat(64);
  await writeFile(
    env.DOCKER_INSPECT,
    JSON.stringify([
      {
        Id: id,
        Config: { Labels: { "org.agent-connect.component": "unowned" } },
      },
    ]),
  );
  const refused = command(["egress", "stop", "--name", "owned-egress"], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not labelled/);
  assert.equal(
    (await readFile(env.DOCKER_ARGS, "utf8")).split("\n")[0],
    "inspect",
  );
  await writeFile(
    env.DOCKER_INSPECT,
    JSON.stringify([
      {
        Id: id,
        Config: { Labels: { "org.agent-connect.component": "acp-egress" } },
      },
    ]),
  );
  assert.equal(
    command(["egress", "stop", "--name", "owned-egress"], env).status,
    0,
  );
  args = (await readFile(env.DOCKER_ARGS, "utf8")).trim().split("\n");
  assert.deepEqual(args, ["rm", "--force", id]);
});

test("release-info reports the compiled default image independently of runtime overrides", () => {
  const result = command(["release-info"], {
    AGENT_CONNECT_SESSION_IMAGE: "runtime:override",
  });
  assert.equal(result.status, 0, result.stderr);
  const release = JSON.parse(result.stdout);
  assert.equal(release.version, "0.1.0-alpha.1");
  assert.match(
    release.sessionImage,
    /^(agent-connect-session:0\.1\.0-alpha\.1|.+@sha256:[a-f0-9]{64})$/,
  );
});

test("relative config argument resolves a dedicated production home to an absolute path", async () => {
  const fixture = await setup();
  assert.equal(command(fixture.args).status, 0);
  const result = await serveUntilReady(
    ["serve", "--config", "runtime/config.json", "--listen", "127.0.0.1:0"],
    {},
    fixture.root,
  );
  assert.equal(result.code, 0, result.stderr);
});

test("flagless login refuses nonterminal input without allocating a home", async () => {
  const { access } = await import("node:fs/promises");
  const state = join(await mkdtemp(join(tmpdir(), "acp-no-tty-")), "state");
  const result = command(["login"], { XDG_STATE_HOME: state });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /needs a terminal.*--harness codex/);
  await assert.rejects(access(state), { code: "ENOENT" });
});

test("login defaults match init, explicit homes and old configs remain usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "acp-login-defaults-"));
  await mkdir(join(root, "bin"));
  await writeFile(
    join(root, "bin/docker"),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$LOGIN_ARGS"\n',
  );
  await chmod(join(root, "bin/docker"), 0o755);
  const env = { PATH: join(root, "bin"), LOGIN_ARGS: join(root, "args") };
  assert.equal(command(["login", "--harness", "codex"], env).status, 0);
  const fixture = await setup();
  assert.equal(command(fixture.args).status, 0);
  const path = join(fixture.directory, "config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  const args = (await readFile(env.LOGIN_ARGS, "utf8")).split("\n");
  assert.ok(
    args.includes(`type=bind,src=${config.harness_home},dst=/home/node`),
  );
  // An existing runtime may still use its relative, per-runtime home/image.
  config.harness_home = "legacy-home";
  config.session_image = "session:legacy-test";
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
      "--session-image",
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
      session_image: "session:legacy-test",
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
  const custom = await setup();
  const home = join(custom.root, "explicit-home");
  assert.equal(command([...custom.args, "--harness-home", home]).status, 0);
  assert.equal(
    JSON.parse(await readFile(join(custom.directory, "config.json")))
      .harness_home,
    home,
  );
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
      const root = await mkdtemp(join(tmpdir(), "acp-selector-"));
      await mkdir(join(root, "bin"));
      await writeFile(
        join(root, "bin/docker"),
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$LOGIN_ARGS"\n',
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
      const canonical = resolve(
        import.meta.dirname,
        "../target/debug/agent-connect",
      );
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
