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
