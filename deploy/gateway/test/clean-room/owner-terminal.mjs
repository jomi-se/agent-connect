// Runs a gateway command on a pseudo-terminal (util-linux `script`) and types the
// owner passphrase at each prompt, as the owner would. The gateway deliberately
// has no file, environment or argument input for the passphrase. Stdout and
// stderr go to private files so structured output stays off the terminal.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const prompt = /passphrase[^\n]*: $/;

export async function ownerTerminal(
  command,
  args,
  passphrase,
  { cwd, env, timeout = 600_000 } = {},
) {
  const output = await mkdtemp(join(tmpdir(), "acp-owner-terminal-"));
  const stdout = join(output, "stdout");
  const stderr = join(output, "stderr");
  try {
    const line = `exec ${[command, ...args].map(quote).join(" ")} >${quote(stdout)} 2>${quote(stderr)}`;
    const child = spawn("script", ["-qefc", line, "/dev/null"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let pending = "";
    let answered = 0;
    child.stdout.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      if (prompt.test(pending)) {
        pending = "";
        answered += 1;
        child.stdin.write(`${passphrase}\n`);
      }
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => resolve(status ?? signal));
    });
    clearTimeout(timer);
    child.stdin.destroy();
    return {
      code,
      answered,
      stdout: await readFile(stdout, "utf8").catch(() => ""),
      stderr: await readFile(stderr, "utf8").catch(() => ""),
    };
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}
