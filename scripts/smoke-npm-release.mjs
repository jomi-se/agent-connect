#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  readReleaseManifest,
  releaseDirectory,
  repositoryRoot,
} from "./npm-release-packages.mjs";

const release = readReleaseManifest();
const sdk = requireEntry("@open-agent-connect/web");
const plugin = requireEntry("@open-agent-connect/openclaw-plugin");

run("node", ["scripts/smoke-web-sdk-package.mjs", tarball(sdk)]);
run("node", ["scripts/smoke-openclaw-plugin-package.mjs", tarball(plugin)]);

process.stdout.write("RELEASE_SMOKE_OK exact SDK and plugin tarballs\n");

function requireEntry(name) {
  const entry = release.packages.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Release manifest is missing ${name}`);
  return entry;
}

function tarball(entry) {
  return resolve(releaseDirectory, entry.filename);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}`,
    );
  }
}
