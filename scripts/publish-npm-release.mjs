#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  readReleaseManifest,
  releaseDirectory,
} from "./npm-release-packages.mjs";

const registry = "https://registry.npmjs.org";
const npmCache = "/tmp/agent-connect-npm-cache";

export function registryVersionState(entry, runner) {
  const result = runner([
    "view",
    `${entry.name}@${entry.version}`,
    "version",
    "--json",
    `--registry=${registry}`,
    `--cache=${npmCache}`,
  ]);
  if (result.status === 0) {
    const actual = JSON.parse(result.stdout);
    if (actual !== entry.version) {
      throw new Error(
        `Registry returned ${JSON.stringify(actual)} for ${entry.name}@${entry.version}`,
      );
    }
    return "published";
  }
  const failure = `${result.stdout}\n${result.stderr}`;
  if (/\bE404\b|404 Not Found/.test(failure)) return "unpublished";
  throw new Error(
    `Registry lookup failed for ${entry.name}@${entry.version}: ${bounded(failure)}`,
  );
}

export function publishPreparedPackages(entries, runner, log = console.log) {
  const outcomes = [];
  for (const entry of entries) {
    const state = registryVersionState(entry, runner);
    if (state === "published") {
      log(
        `SKIP ${entry.name}@${entry.version} already published sha256:${entry.sha256}`,
      );
      outcomes.push({ ...entry, outcome: "skipped" });
      continue;
    }

    const result = runner([
      "publish",
      resolve(releaseDirectory, entry.filename),
      "--access",
      "public",
      "--provenance",
      `--registry=${registry}`,
      `--cache=${npmCache}`,
    ]);
    if (result.status !== 0) {
      throw new Error(
        `Publish failed for ${entry.name}@${entry.version}: ${bounded(
          `${result.stdout}\n${result.stderr}`,
        )}`,
      );
    }
    log(`PUBLISHED ${entry.name}@${entry.version} sha256:${entry.sha256}`);
    outcomes.push({ ...entry, outcome: "published" });
  }
  return outcomes;
}

function verifyPreparedArtifacts(entries) {
  for (const entry of entries) {
    const actual = createHash("sha256")
      .update(readFileSync(resolve(releaseDirectory, entry.filename)))
      .digest("hex");
    if (actual !== entry.sha256) {
      throw new Error(
        `Prepared tarball digest changed for ${entry.name}@${entry.version}`,
      );
    }
  }
}

function runNpm(args) {
  return spawnSync("npm", args, { encoding: "utf8" });
}

function bounded(value) {
  const normalized = value.trim();
  return normalized.length <= 4000 ? normalized : normalized.slice(-4000);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const release = readReleaseManifest();
  verifyPreparedArtifacts(release.packages);
  publishPreparedPackages(release.packages, runNpm);
}
