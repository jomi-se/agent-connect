// Hashes what a CI job depends on, so a job whose inputs a green run already
// verified can be reused instead of run again (.github/workflows/ci.yml).
//
// Each job lists what it does NOT depend on; every other tracked file is an
// input. A file nobody thought about therefore makes the job run, never skip.
// Our own packages' versions are normalized out of the manifests and
// lockfiles, so a release bump reuses the results of the commit it bumps; the
// static job, which always runs, checks the versions themselves. Only fields
// that name our own packages are touched: a third-party dependency that
// happens to share our version number still counts.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Bump this to invalidate every recorded green result at once.
export const SCHEMA = 1;

// Docs, and changelogs: their text ships in the packages but nothing tests it,
// and the static job packs the packages on every run.
const docs = ["docs/", "*CHANGELOG.md"];
export const jobs = {
  // Rust reads crates/ and the files it compiles in with include_str!, which
  // scripts/ci-inputs.test.mjs keeps listed in `keep`.
  rust: {
    exclude: [...docs, "scripts/", "packages/", "examples/", "deploy/", "*.md"],
    keep: ["deploy/gateway/box/entrypoint.sh"],
  },
  // The web SDK, its package and WebMCP. No Rust, no gateway deploy files.
  web: {
    exclude: [
      ...docs,
      "crates/",
      "deploy/",
      "packages/gateway-npm/",
      "Cargo.toml",
      "Cargo.lock",
      "rust-toolchain.toml",
      "dist-workspace.toml",
    ],
  },
  // The release build and every gateway scenario use nearly everything,
  // the web SDK included (use-chat, the clean room).
  gateway: { exclude: [...docs] },
};

export function excluded(path, patterns, keep = []) {
  if (keep.includes(path)) return false;
  return patterns.some((pattern) =>
    pattern.startsWith("*")
      ? path.endsWith(pattern.slice(1))
      : pattern.endsWith("/")
        ? path.startsWith(pattern)
        : path === pattern,
  );
}

const OURS = "@open-agent-connect/";
const PLACEHOLDER = "@VERSION@";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function ownVersions(repository) {
  return new Set(
    ["packages/gateway-npm", "packages/web-sdk"].map(
      (dir) =>
        JSON.parse(readFileSync(join(repository, dir, "package.json"), "utf8"))
          .version,
    ),
  );
}

function ownCrates(repository, files) {
  return new Set(
    files
      .filter((path) => /^crates\/[^/]+\/Cargo\.toml$/.test(path))
      .map(
        (path) =>
          readFileSync(join(repository, path), "utf8").match(
            /^name\s*=\s*"([^"]+)"/m,
          )?.[1],
      )
      .filter(Boolean),
  );
}

function normalizeEntry(entry, own, versionIsOurs) {
  if (versionIsOurs && own.has(entry.version)) entry.version = PLACEHOLDER;
  for (const field of DEPENDENCY_FIELDS)
    for (const [name, range] of Object.entries(entry[field] ?? {}))
      if (
        name.startsWith(OURS) &&
        own.has(String(range).replace(/^[\^~=]/, ""))
      )
        entry[field][name] = PLACEHOLDER;
}

// A manifest's own version, its references to our packages, and lockfile
// entries for our workspace packages and crates. Nothing else.
export function normalize(path, text, own, crates) {
  const name = basename(path);
  try {
    return normalizeManifest(name, text, own, crates);
  } catch {
    return text; // Not a manifest we can read (a test fixture): hash as is.
  }
}

function normalizeManifest(name, text, own, crates) {
  if (name === "package.json") {
    const manifest = JSON.parse(text);
    normalizeEntry(manifest, own, true);
    return JSON.stringify(manifest);
  }
  if (name === "package-lock.json") {
    const lock = JSON.parse(text);
    normalizeEntry(lock, own, true);
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      const workspace =
        !key.includes("node_modules/") || key.includes(`node_modules/${OURS}`);
      normalizeEntry(entry, own, workspace);
    }
    return JSON.stringify(lock);
  }
  if (name === "Cargo.toml")
    return text.replace(/^(version\s*=\s*")([^"]+)(")/m, (line, a, v, b) =>
      own.has(v) ? a + PLACEHOLDER + b : line,
    );
  if (name === "Cargo.lock")
    return text
      .split("\n\n")
      .map((block) => {
        const crate = block.match(/^name = "([^"]+)"/m)?.[1];
        return crates.has(crate)
          ? block.replace(/^version = "([^"]+)"/m, (line, v) =>
              own.has(v) ? `version = "${PLACEHOLDER}"` : line,
            )
          : block;
      })
      .join("\n\n");
  return text;
}

export function inputsHash(
  job,
  repository = resolve(import.meta.dirname, ".."),
) {
  const spec = jobs[job];
  if (!spec)
    throw new Error(
      `unknown job ${job}; choose from ${Object.keys(jobs).join(", ")}`,
    );
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: repository,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const own = ownVersions(repository);
  const crates = ownCrates(repository, tracked);
  const files = tracked
    .filter((path) => !excluded(path, spec.exclude, spec.keep))
    .sort();
  const hash = createHash("sha256").update(`schema ${SCHEMA}\0job ${job}\0`);
  for (const path of files) {
    const full = join(repository, path);
    const stat = lstatSync(full, { throwIfNoEntry: false });
    let kind, content;
    if (!stat) {
      kind = "deleted";
      content = Buffer.alloc(0);
    } else if (stat.isSymbolicLink()) {
      kind = "link";
      content = Buffer.from(readlinkSync(full));
    } else {
      kind = stat.mode & 0o111 ? "exec" : "file";
      content = readFileSync(full);
      const normalized = normalize(path, content.toString("utf8"), own, crates);
      if (normalized !== content.toString("utf8"))
        content = Buffer.from(normalized);
    }
    const digest = createHash("sha256").update(content).digest("hex");
    hash.update(`${kind} ${path} ${digest}\0`);
  }
  return hash.digest("hex");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(inputsHash(process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
