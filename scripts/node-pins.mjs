// The Node version this repository builds and tests with lives in one file,
// .node-version. Everything else reads it (setup-node's node-version-file, the
// mock model's image) or has to agree with it, and this check names whatever
// doesn't, so a Node bump that misses a spot fails `release.mjs check` locally
// and in the static job instead of in a container gate after the push.
//
// Published packages keep floors of their own, since users may run an older
// Node than CI does, but a package must not demand a newer Node than the one
// CI tests it on.
//
// Code doesn't compare Node versions by hand either. Where a test needs a
// supported Node, `npm install --engine-strict` enforces each package's own
// engines field, which stays right when the version moves.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// This check and its fixtures name other versions on purpose.
const SELF = ["scripts/node-pins.mjs", "scripts/node-pins.test.mjs"];
const REPOSITORY_MANIFESTS = ["package.json", "examples/acp-chat/package.json"];
const PUBLISHED_MANIFESTS = [
  "packages/gateway-npm/package.json",
  "packages/web-sdk/package.json",
];

export function readNodeVersion(repo = resolve(import.meta.dirname, "..")) {
  const text = readFileSync(join(repo, ".node-version"), "utf8").trim();
  const match = text.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match)
    throw new Error(
      `.node-version must hold one exact version such as 26.13.0, not "${text}"`,
    );
  return { text, major: Number(match[1]), minor: Number(match[2]) };
}

// Text where a Node version could hide. Docs and changelogs describe
// versions in prose; the lockfile is checked through its root entry.
function scannedFiles(repo) {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repo,
    encoding: "utf8",
  })
    .split("\0")
    .filter(
      (path) =>
        path &&
        !SELF.includes(path) &&
        !path.startsWith("docs/") &&
        !path.endsWith(".md") &&
        !path.endsWith("package-lock.json"),
    );
}

function lines(repo, path) {
  try {
    return readFileSync(join(repo, path), "utf8").split("\n");
  } catch {
    return []; // Deleted in the working tree, or not text we can read.
  }
}

function manifestProblems(repo, { text, major, minor }) {
  const problems = [];
  const json = (path) => JSON.parse(readFileSync(join(repo, path), "utf8"));
  const range = `>=${major}.${minor} <${major + 1}`;
  for (const path of REPOSITORY_MANIFESTS) {
    const engines = json(path).engines?.node;
    if (engines !== range)
      problems.push(
        `${path}: engines.node is ${JSON.stringify(engines)}; .node-version ${text} means "${range}"`,
      );
  }
  const lockEngines = json("package-lock.json").packages?.[""]?.engines?.node;
  if (lockEngines !== range)
    problems.push(
      `package-lock.json: the root engines.node is ${JSON.stringify(lockEngines)}; run npm install to record "${range}"`,
    );
  for (const path of PUBLISHED_MANIFESTS) {
    const problem = floorProblem(json(path).engines?.node ?? "", {
      text,
      major,
      minor,
    });
    if (problem) problems.push(`${path}: ${problem}`);
  }
  return problems;
}

function floorProblem(engines, { text, major, minor }) {
  const floor = engines.match(/^>=(\d+)(?:\.(\d+))?/);
  if (!floor)
    return `engines.node must start with a floor such as ">=24.15", not ${JSON.stringify(engines)}`;
  const [floorMajor, floorMinor] = [Number(floor[1]), Number(floor[2] ?? 0)];
  if (floorMajor > major || (floorMajor === major && floorMinor > minor))
    return `engines.node ${engines} asks for a newer Node than CI tests on (${text})`;
  return undefined;
}

function workflowProblems(path, content) {
  const problems = [];
  let setups = 0;
  let reads = 0;
  content.forEach((line, index) => {
    if (/uses:\s*actions\/setup-node@/.test(line)) setups++;
    if (/^\s*node-version-file:\s*\.node-version\s*$/.test(line)) reads++;
    if (/^\s*node-version:/.test(line))
      problems.push(
        `${path}:${index + 1}: use node-version-file: .node-version, not node-version`,
      );
  });
  if (setups !== reads)
    problems.push(
      `${path}: ${setups} setup-node steps but ${reads} read .node-version`,
    );
  return problems;
}

function lineProblems(path, content, { text, major }) {
  const problems = [];
  content.forEach((line, index) => {
    for (const image of line.matchAll(/\bnode:(\d+)(?![\d.])/g))
      if (Number(image[1]) !== major)
        problems.push(
          `${path}:${index + 1}: image node:${image[1]} differs from .node-version ${text}`,
        );
    if (
      /process\.versions?(?:\.node)?\s*\.\s*(?:split|slice|match|startsWith)\b/.test(
        line,
      )
    )
      problems.push(
        `${path}:${index + 1}: parses the Node version by hand; let npm --engine-strict enforce engines instead`,
      );
  });
  return problems;
}

export function nodePinProblems(repo = resolve(import.meta.dirname, "..")) {
  let version;
  try {
    version = readNodeVersion(repo);
  } catch (error) {
    return [error.message];
  }
  const problems = manifestProblems(repo, version);
  for (const path of scannedFiles(repo)) {
    const content = lines(repo, path);
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))
      problems.push(...workflowProblems(path, content));
    problems.push(...lineProblems(path, content, version));
  }
  return problems;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const problems = nodePinProblems();
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exitCode = 1;
  else
    console.log(`Node pins agree with .node-version ${readNodeVersion().text}`);
}
