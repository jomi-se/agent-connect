import * as fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function entry(filename) {
  try {
    return fs.lstatSync(filename);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Share only auth.json. Migration requires all runtime writers to be stopped. */
export function linkCodexAuth(
  sourceHome,
  runtimeHome,
  { migrate = false, createLink = fs.symlinkSync } = {},
) {
  if (
    !sourceHome ||
    !runtimeHome ||
    !path.isAbsolute(sourceHome) ||
    !path.isAbsolute(runtimeHome)
  ) {
    throw new Error(
      "Source auth home and runtime CODEX_HOME must be absolute paths",
    );
  }
  let sourceDirectory;
  try {
    sourceDirectory = fs.realpathSync(sourceHome);
  } catch {
    throw new Error(
      "Source Codex auth home is missing; select the machine login with AGENT_CONNECT_CODEX_AUTH_HOME",
    );
  }
  const source = path.join(sourceDirectory, "auth.json");
  const sourceStat = entry(source);
  if (!sourceStat?.isFile()) {
    throw new Error(
      "Source auth.json must be an existing regular file. Keyring-only login is unsupported; configure file credential storage for the same machine account first",
    );
  }
  fs.mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  const runtimeDirectory = fs.realpathSync(runtimeHome);
  if (sourceDirectory === runtimeDirectory) {
    throw new Error(
      "Runtime CODEX_HOME must be distinct from the source auth home (including aliases)",
    );
  }
  const destination = path.join(runtimeDirectory, "auth.json");
  const current = entry(destination);
  if (current?.isSymbolicLink()) {
    // Compare the link's path, not merely its current inode: source auth.json
    // may be atomically replaced on the next refresh.
    const linked = path.resolve(runtimeDirectory, fs.readlinkSync(destination));
    const linkedDirectory = fs.realpathSync(path.dirname(linked));
    if (path.join(linkedDirectory, path.basename(linked)) === source)
      return { linked: false };
    throw new Error(
      "Runtime auth.json is an unexpected symlink; refusing to replace it",
    );
  }
  if (current && !current.isFile()) {
    throw new Error(
      "Runtime auth.json is not a regular file or expected symlink; refusing to replace it",
    );
  }
  if (
    current &&
    current.dev === sourceStat.dev &&
    current.ino === sourceStat.ino
  ) {
    throw new Error(
      "Runtime auth.json aliases the source file; refusing to modify it",
    );
  }
  if (current && !migrate) {
    throw new Error(
      "Runtime auth.json already exists. Stop runtime writers, then run this helper explicitly with --migrate",
    );
  }
  if (!current) {
    createLink(source, destination);
    return { linked: true };
  }

  // A private, unique directory protects the old credential even before chmod.
  const backupDirectory = fs.mkdtempSync(`${destination}.backup-`);
  const backup = path.join(backupDirectory, "auth.json");
  fs.renameSync(destination, backup);
  try {
    fs.chmodSync(backup, 0o600);
    createLink(source, destination);
  } catch (error) {
    // linkSync restores without overwriting any unexpected concurrent arrival.
    try {
      fs.linkSync(backup, destination);
      fs.unlinkSync(backup);
      fs.rmdirSync(backupDirectory);
    } catch {
      throw new Error(
        `Auth link failed; backup retained at ${backup}. Stop writers and restore manually`,
      );
    }
    throw new Error(
      `Auth link failed; original runtime auth restored (${error.code ?? "link error"})`,
    );
  }
  return { linked: true, backup };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const migrate = args[0] === "--migrate";
  if (migrate) args.shift();
  try {
    if (args.length !== 2)
      throw new Error(
        "Usage: node scripts/link-codex-auth.mjs [--migrate] SOURCE_AUTH_HOME RUNTIME_CODEX_HOME",
      );
    const result = linkCodexAuth(args[0], args[1], { migrate });
    console.log(
      result.backup
        ? `Shared Codex auth linked; old runtime auth backed up at ${result.backup}`
        : "Shared Codex auth link ready",
    );
  } catch (error) {
    console.error(`Agent Connect: ${error.message}`);
    process.exitCode = 78;
  }
}
