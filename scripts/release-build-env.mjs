// Keep builder locations out of distributed Rust executables, including panic locations.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function encodedReleaseRustflags(env, repository) {
  const flags =
    env.CARGO_ENCODED_RUSTFLAGS !== undefined
      ? env.CARGO_ENCODED_RUSTFLAGS.split("\x1f").filter(Boolean)
      : (env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean);
  for (const [source, destination] of [
    [repository, "/agent-connect"],
    [env.CARGO_HOME ?? join(homedir(), ".cargo"), "/cargo"],
    [env.RUSTUP_HOME ?? join(homedir(), ".rustup"), "/rustup"],
  ])
    flags.push(`--remap-path-prefix=${resolve(source)}=${destination}`);
  return flags.join("\x1f");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.stdout.write(
    encodedReleaseRustflags(process.env, resolve(import.meta.dirname, "..")),
  );
