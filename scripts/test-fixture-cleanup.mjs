import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Only call after fixture-owned processes stop, with the private mkdtemp root.
// Preserve evidence, discard reconstructible installs, and never follow links.
export async function pruneTestInstallations(
  directory,
  {
    keepInstallations = process.env.AGENT_CONNECT_KEEP_TEST_INSTALLS === "1",
  } = {},
) {
  if (keepInstallations) return;
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true }).catch(
      (error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (
        [
          "node_modules",
          "cache",
          "npm-cache",
          "node-compile-cache",
          ".cache",
          ".npm",
        ].includes(entry.name)
      ) {
        await rm(child, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        await visit(child);
      }
    }
  }
  await visit(directory);
}

// Keep independent cleanup attempts running even when one throws synchronously.
// Report failures only once every attempted cleanup has settled.
export async function runCleanupTasks(tasks) {
  const results = await Promise.allSettled(
    tasks.map((task) => Promise.resolve().then(task)),
  );
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length)
    throw new AggregateError(
      failures,
      "Fixture cleanup failed after all owned cleanup tasks were attempted",
    );
}

// Await termination of one fixture-owned child. A process-group sender may be
// supplied for children launched with detached:true. Never equate KILL with exit.
// Return whether KILL was required so callers can retain stricter failure policy.
export async function stopFixtureChild(
  child,
  {
    exited,
    signal = (value) => child.kill(value),
    graceMs = 5000,
    killMs = 5000,
  } = {},
) {
  if (!child || child.exitCode !== null || child.signalCode !== null)
    return false;
  let onExit;
  const completion =
    exited ??
    new Promise((resolve) => {
      onExit = resolve;
      child.once("exit", onExit);
    });
  function send(value) {
    try {
      signal(value);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  async function stoppedWithin(ms) {
    let timer;
    try {
      return await Promise.race([
        completion.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    send("SIGTERM");
    if (await stoppedWithin(graceMs)) return false;
    send("SIGKILL");
    if (!(await stoppedWithin(killMs)))
      throw new Error(
        "Owned fixture process did not exit after SIGKILL; preserving its files",
      );
    return true;
  } finally {
    if (onExit) child.removeListener("exit", onExit);
  }
}
