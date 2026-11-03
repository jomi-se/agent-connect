import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * A PATH that shows the gateway a rootless Docker, so fixtures that create a
 * runtime with `setup` pass its rootful-engine gate on any host. Only the
 * rootless probe is answered; every other command, other `info` queries
 * included, reaches the real `docker`, if there is one.
 */
export async function rootlessEnginePath(directory, path = process.env.PATH) {
  const bin = join(directory, "engine-bin");
  await mkdir(bin, { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v docker"], {
    encoding: "utf8",
    env: { PATH: path },
  }).stdout.trim();
  const fallthrough = real
    ? `exec '${real}' "$@"`
    : 'echo "docker: not installed" >&2; exit 127';
  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh\ncase "$*" in "info --format "*SecurityOptions*) echo '{"securityOptions":["name=rootless"],"operatingSystem":"Linux"}'; exit 0;; esac\n${fallthrough}\n`,
  );
  await chmod(join(bin, "docker"), 0o755);
  return `${bin}:${path}`;
}
