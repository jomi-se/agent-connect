import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export const repositoryRoot = resolve(import.meta.dirname, "..");
export const releaseDirectory = resolve(repositoryRoot, "dist/npm-release");
export const releaseManifestPath = resolve(releaseDirectory, "manifest.json");

export const releasePackages = [
  {
    name: "@open-agent-connect/web",
    workspace: "packages/web-sdk",
    requiredFiles: [
      "LICENSE",
      "README.md",
      "dist/index.d.ts",
      "dist/index.js",
      "package.json",
    ],
  },
  {
    name: "@open-agent-connect/openclaw-plugin",
    workspace: "packages/openclaw-plugin",
    requiredFiles: [
      "LICENSE",
      "README.md",
      "dist/index.mjs",
      "dist/index.mjs.map",
      "openclaw.plugin.json",
      "package.json",
    ],
  },
];

export function readPackageManifest(candidate) {
  return JSON.parse(
    readFileSync(
      resolve(repositoryRoot, candidate.workspace, "package.json"),
      "utf8",
    ),
  );
}

export function readReleaseManifest() {
  const value = JSON.parse(readFileSync(releaseManifestPath, "utf8"));
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.packages) ||
    value.packages.length !== releasePackages.length
  ) {
    throw new Error(
      "Release manifest does not contain the explicit two-package set",
    );
  }
  for (const candidate of releasePackages) {
    const matches = value.packages.filter(
      (entry) => entry.name === candidate.name,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Release manifest must contain ${candidate.name} exactly once`,
      );
    }
    const [entry] = matches;
    const packageJson = readPackageManifest(candidate);
    if (
      entry.version !== packageJson.version ||
      typeof entry.filename !== "string" ||
      basename(entry.filename) !== entry.filename ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error(
        `Release manifest has invalid artifact metadata for ${candidate.name}`,
      );
    }
  }
  return value;
}
