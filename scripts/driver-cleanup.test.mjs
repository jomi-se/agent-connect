import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCleanupTasks } from "./test-fixture-cleanup.mjs";
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const source = await readFile(
  new URL("./owner-ui.mjs", import.meta.url),
  "utf8",
);
const body = source.slice(
  source.lastIndexOf("  // Every owned process"),
  source.lastIndexOf("\n}"),
);
const cleanup = new AsyncFunction(
  "runCleanupTasks",
  "browser",
  "application",
  "stopGateway",
  "gateway",
  "gatewayExit",
  "problemGateway",
  "problemGatewayExit",
  "problemEgressAllocated",
  "run",
  "binary",
  "problemEgress",
  "readdir",
  "root",
  "rm",
  "join",
  "preserveRoot",
  body,
);
for (const fail of [false, true]) {
  test(`owner cleanup waits for all users before filesystem deletion (stop failure=${fail})`, async () => {
    let release;
    const exited = new Promise((resolve) => {
      release = resolve;
    });
    let stopped = false;
    let removed = false;
    const result = cleanup(
      runCleanupTasks,
      undefined,
      { close: (cb) => cb() },
      async (child) => {
        if (child) {
          await exited;
          if (fail) throw new Error("gateway remains alive");
          stopped = true;
        }
      },
      {},
      exited,
      undefined,
      undefined,
      false,
      () => {},
      "gateway",
      "egress",
      async () => ["runtime"],
      "/fixture",
      async () => {
        assert.ok(
          stopped,
          "Files must remain until process shutdown completes",
        );
        removed = true;
      },
      join,
      false,
    );
    const settled = fail ? assert.rejects(result, AggregateError) : result;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(removed, false);
    release();
    await settled;
    assert.equal(removed, !fail);
  });
}
const helperSource = await readFile(
  new URL("./test-fixture-cleanup.mjs", import.meta.url),
  "utf8",
);
const stopSource = helperSource
  .slice(helperSource.indexOf("export async function stopFixtureChild"))
  .replace("export ", "");
for (const exits of [true, false]) {
  test(`owner shutdown requires exit acknowledgement after SIGKILL (exits=${exits})`, async () => {
    const timers = [];
    const cleared = [];
    const stop = new Function(
      "assert",
      "setTimeout",
      "clearTimeout",
      stopSource + "\nreturn stopFixtureChild;",
    )(
      assert,
      (callback) => {
        timers.push(callback);
        return callback;
      },
      (timer) => cleared.push(timer),
    );
    const signals = [];
    let exit;
    const exited = new Promise((resolve) => {
      exit = resolve;
    });
    let settled = false;
    const result = stop(
      {
        exitCode: null,
        signalCode: null,
        kill: (signal) => signals.push(signal),
      },
      { exited },
    ).then(() => {
      settled = true;
    });
    const checked = exits
      ? result
      : assert.rejects(result, /did not exit after SIGKILL/);
    assert.deepEqual(signals, ["SIGTERM"]);
    timers.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(
      settled,
      false,
      "Sending SIGKILL is not proof that the child exited",
    );
    if (exits) exit();
    else timers.shift()();
    await checked;
    assert.equal(cleared.length, 2);
  });
}

test("a nested retainedDirectory error preserves the whole diagnostic root after other processes stop", async () => {
  const failure = new Error("Nested shutdown was not confirmed");
  Object.defineProperty(failure, "retainedDirectory", {
    value: "/fixture/nested",
  });
  const catchStart = source.lastIndexOf("} catch (error) {");
  const catchBody = source.slice(
    catchStart + "} catch (error) {".length,
    source.indexOf("  throw error;", catchStart),
  );
  const preserve = new Function(
    "error",
    `let preserveRoot = false; ${catchBody}\nreturn preserveRoot;`,
  );
  assert.equal(preserve(failure), true);
  assert.equal(preserve(new Error("ordinary failure")), false);
  const stopped = [];
  await cleanup(
    runCleanupTasks,
    { close: async () => stopped.push("browser") },
    {
      close: (cb) => {
        stopped.push("application");
        cb();
      },
    },
    async (child) => {
      if (child) stopped.push(child.name);
    },
    { name: "gateway" },
    Promise.resolve(),
    { name: "problem" },
    Promise.resolve(),
    false,
    () => {},
    "gateway",
    "egress",
    async () => {
      assert.fail("Preserved root must not be swept");
    },
    "/fixture",
    async () => assert.fail("Preserved root must not be removed"),
    join,
    preserve(failure),
  );
  assert.deepEqual(stopped.sort(), [
    "application",
    "browser",
    "gateway",
    "problem",
  ]);
});

test("teardown retains failure status when its gateway requires KILL", async () => {
  const text = await readFile(
    new URL("./gateway-teardown.mjs", import.meta.url),
    "utf8",
  );
  const code = text.slice(
    text.indexOf("async function stop(child)"),
    text.indexOf("async function sessions(dir)"),
  );
  for (const forced of [false, true]) {
    const stop = new Function("stopFixtureChild", code + "\nreturn stop;")(
      async (_child, options) => {
        assert.equal(options.graceMs, 30000);
        return forced;
      },
    );
    if (forced) await assert.rejects(stop({}), /KILL exit confirmed/);
    else await stop({});
  }
});

test("scenario cleanup retains process-group signaling and removes tracking only after stop settles", async () => {
  const text = await readFile(
    new URL("./gateway-scenarios.mjs", import.meta.url),
    "utf8",
  );
  const code = text.slice(
    text.indexOf("async function stop(child)"),
    text.indexOf("async function port()"),
  );
  const child = { pid: 12345 };
  const children = new Set([child]);
  const signals = [];
  let release;
  const done = new Promise((resolve) => {
    release = resolve;
  });
  const stop = new Function(
    "stopFixtureChild",
    "process",
    "children",
    code + "\nreturn stop;",
  )(
    async (actual, options) => {
      assert.equal(actual, child);
      assert.equal(options.graceMs, 3000);
      options.signal("SIGTERM");
      await done;
    },
    { kill: (...args) => signals.push(args) },
    children,
  );
  const stopping = stop(child);
  assert.ok(children.has(child));
  assert.deepEqual(signals, [[-12345, "SIGTERM"]]);
  release();
  await stopping;
  assert.equal(children.size, 0);
});

for (const failure of ["child", "container", undefined]) {
  test(`scenario finalizer attempts independent cleanup and preserves files on ${failure ?? "no"} failure`, async () => {
    const text = await readFile(
      new URL("./gateway-scenarios.mjs", import.meta.url),
      "utf8",
    );
    const finalizer = text.slice(
      text.lastIndexOf("} finally {") + "} finally {".length,
      text.lastIndexOf("\n}"),
    );
    const finish = new AsyncFunction(
      "runCleanupTasks",
      "children",
      "stop",
      "dockerContainers",
      "dockerNetworks",
      "command",
      "pageServer",
      "pruneTestInstallations",
      "run",
      "console",
      finalizer,
    );
    const calls = [];
    const error = new Error(`Injected ${failure} cleanup failure`);
    let releaseSibling;
    const sibling = new Promise((resolve) => {
      releaseSibling = resolve;
    });
    let closeServer;
    const cleanup = finish(
      runCleanupTasks,
      new Set(["failed", "sibling"]),
      async (child) => {
        calls.push(`stop ${child}`);
        if (child === "failed" && failure === "child") throw error;
        if (child === "sibling") {
          await sibling;
          calls.push("sibling stopped");
        }
      },
      ["owned-one", "owned-two"],
      ["owned-network"],
      async (binary, args) => {
        assert.equal(binary, "docker");
        calls.push(args.join(" "));
        if (failure === "container" && args[2] === "owned-one") throw error;
      },
      {
        close(callback) {
          calls.push("server close");
          closeServer = callback;
        },
        closeAllConnections() {
          calls.push("server connections closed");
          closeServer();
        },
      },
      async () => calls.push("prune"),
      "/fixture/scenario-run",
      { log: (line) => calls.push(line) },
    );
    const checked = failure
      ? assert.rejects(cleanup, (actual) => {
          assert.ok(actual instanceof AggregateError);
          assert.deepEqual(actual.errors, [error]);
          assert.ok(actual.message.includes("/fixture/scenario-run"));
          return true;
        })
      : cleanup;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(calls.includes("server close"));
    assert.ok(calls.includes("server connections closed"));
    assert.ok(!calls.includes("prune"));
    releaseSibling();
    await checked;
    for (const call of [
      "sibling stopped",
      "rm -f owned-one",
      "rm -f owned-two",
      "network rm owned-network",
    ])
      assert.ok(calls.includes(call), `Missing independent cleanup: ${call}`);
    assert.ok(
      calls.indexOf("network rm owned-network") >
        calls.indexOf("rm -f owned-two"),
    );
    assert.equal(calls.includes("prune"), !failure);
  });
}

for (const failure of ["gateway", "context", undefined]) {
  test(`cookie fixture cleanup waits for shutdown and retains its directory on ${failure ?? "no"} failure`, async () => {
    const text = await readFile(
      new URL("./owner-cookie-browser.mjs", import.meta.url),
      "utf8",
    );
    const finalizer = text.slice(
      text.lastIndexOf("  } finally {") + "  } finally {".length,
      text.lastIndexOf("\n  }"),
    );
    const finish = new AsyncFunction(
      "runCleanupTasks",
      "context",
      "upstreams",
      "proxy",
      "sockets",
      "stopFixtureChild",
      "gateway",
      "gatewayClosed",
      "rm",
      "directory",
      finalizer,
    );
    const calls = [];
    let release;
    const closed = new Promise((resolve) => {
      release = resolve;
    });
    const child = {};
    const cleanup = finish(
      runCleanupTasks,
      {
        close: async () => {
          calls.push("context close");
          if (failure === "context") throw new Error("private context failure");
        },
      },
      [{ destroy: () => calls.push("upstream destroy") }],
      {
        listening: true,
        close: (callback) => {
          calls.push("proxy close");
          callback();
        },
      },
      [{ destroy: () => calls.push("socket destroy") }],
      async (actual, options) => {
        assert.equal(actual, child);
        assert.equal(options.exited, closed);
        calls.push("gateway stop");
        await closed;
        calls.push("gateway stop settled");
        if (failure === "gateway") throw new Error("private signal failure");
      },
      child,
      closed,
      async () => {
        assert.ok(calls.includes("gateway stop settled"));
        calls.push("rm");
      },
      "/fixture/cookie-browser",
    );
    const checked = failure
      ? assert.rejects(cleanup, (error) => {
          assert.equal(error.retainedDirectory, "/fixture/cookie-browser");
          assert.equal(
            Object.prototype.propertyIsEnumerable.call(
              error,
              "retainedDirectory",
            ),
            false,
          );
          assert.ok(!error.message.includes("private"));
          return true;
        })
      : cleanup;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!calls.includes("rm"));
    release();
    await checked;
    for (const call of [
      "context close",
      "upstream destroy",
      "proxy close",
      "socket destroy",
      "gateway stop settled",
    ])
      assert.ok(calls.includes(call), `Missing independent cleanup: ${call}`);
    assert.equal(calls.includes("rm"), !failure);
  });
}
