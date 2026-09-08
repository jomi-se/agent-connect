#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  readPackageManifest,
  releaseDirectory,
  releaseManifestPath,
  releasePackages,
  repositoryRoot,
} from "./npm-release-packages.mjs";

const npmCache = "/tmp/agent-connect-npm-cache";
const forbiddenPath =
  /(^|\/)(?:\.env(?:\.|$)|\.agent-connect(?:\/|$)|openclaw-host(?:\/|$))/;
const forbiddenContent = [
  /\/home\/dev\//,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:^|\n)OPENCLAW_TOKEN=/,
];

rmSync(releaseDirectory, { recursive: true, force: true });
mkdirSync(releaseDirectory, { recursive: true });

const packed = [];
for (const candidate of releasePackages) {
  const packageJson = readPackageManifest(candidate);
  if (packageJson.name !== candidate.name) {
    throw new Error(
      `${candidate.workspace} is ${packageJson.name}, expected ${candidate.name}`,
    );
  }
  requirePublicMetadata(candidate, packageJson);

  const output = execFileSync(
    "npm",
    [
      "pack",
      "--json",
      "--workspace",
      candidate.name,
      "--pack-destination",
      releaseDirectory,
      "--cache",
      npmCache,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const result = JSON.parse(output)[0];
  if (
    !result ||
    result.name !== candidate.name ||
    result.version !== packageJson.version
  ) {
    throw new Error(
      `npm pack returned unexpected metadata for ${candidate.name}`,
    );
  }

  const paths = new Set(result.files.map((file) => file.path));
  for (const required of candidate.requiredFiles) {
    if (!paths.has(required)) {
      throw new Error(`${candidate.name} tarball is missing ${required}`);
    }
  }
  for (const path of paths) {
    if (
      isAbsolute(path) ||
      path.split("/").includes("..") ||
      forbiddenPath.test(path)
    ) {
      throw new Error(
        `${candidate.name} tarball includes forbidden path ${path}`,
      );
    }
  }

  const tarballPath = resolve(releaseDirectory, result.filename);
  inspectTarball(candidate, tarballPath, paths);
  const sha256 = createHash("sha256")
    .update(readFileSync(tarballPath))
    .digest("hex");
  packed.push({
    name: candidate.name,
    version: packageJson.version,
    filename: result.filename,
    sha256,
  });
  process.stdout.write(
    `PACKED ${candidate.name}@${packageJson.version} sha256:${sha256}\n`,
  );
}

writeFileSync(
  releaseManifestPath,
  `${JSON.stringify({ schemaVersion: 1, packages: packed }, null, 2)}\n`,
);

function requirePublicMetadata(candidate, packageJson) {
  if (packageJson.private === true) {
    throw new Error(`${candidate.name} remains private`);
  }
  if (packageJson.publishConfig?.access !== "public") {
    throw new Error(`${candidate.name} does not declare public publish access`);
  }
  if (
    packageJson.license !== "MIT" ||
    packageJson.repository?.url !==
      "git+https://github.com/jomi-se/agent-connect.git" ||
    packageJson.repository?.directory !== candidate.workspace ||
    typeof packageJson.homepage !== "string"
  ) {
    throw new Error(`${candidate.name} has incomplete release metadata`);
  }
  for (const [name, specifier] of Object.entries(
    packageJson.dependencies ?? {},
  )) {
    if (/^(?:file|link|workspace):/.test(specifier)) {
      throw new Error(
        `${candidate.name} dependency ${name} is not registry-resolvable`,
      );
    }
  }
}

function inspectTarball(candidate, tarballPath, paths) {
  const inspectionRoot = join(
    releaseDirectory,
    `.inspect-${candidate.name.split("/").at(-1)}`,
  );
  rmSync(inspectionRoot, { recursive: true, force: true });
  mkdirSync(inspectionRoot, { recursive: true });
  try {
    execFileSync("tar", ["-xzf", tarballPath, "-C", inspectionRoot]);
    const packageRoot = join(inspectionRoot, "package");
    for (const path of paths) {
      const body = readFileSync(join(packageRoot, path));
      if (body.includes(0)) continue;
      const text = body.toString("utf8");
      for (const pattern of forbiddenContent) {
        if (pattern.test(text)) {
          throw new Error(
            `${candidate.name} ${path} contains private build material`,
          );
        }
      }
    }
    if (candidate.name.endsWith("openclaw-plugin")) {
      const sourceMap = JSON.parse(
        readFileSync(join(packageRoot, "dist/index.mjs.map"), "utf8"),
      );
      for (const source of sourceMap.sources ?? []) {
        if (isAbsolute(source) || source.includes("/home/")) {
          throw new Error(
            `Plugin sourcemap leaks an absolute source path: ${source}`,
          );
        }
      }
    }
  } finally {
    rmSync(inspectionRoot, { recursive: true, force: true });
  }
}
