// Produce local per-platform npm packages. Never publishes or downloads binaries.
import { mkdir, copyFile, chmod, writeFile, readFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { createHash } from "node:crypto";
const [target, binary] = process.argv.slice(2);
const platforms = {
  "aarch64-apple-darwin": ["darwin", "arm64"],
  "x86_64-unknown-linux-musl": ["linux", "x64"],
  "aarch64-unknown-linux-musl": ["linux", "arm64"],
};
if (!platforms[target] || !binary)
  throw new Error("Usage: node scripts/package-gateway.mjs <target> <binary>");
if (basename(binary) !== "agent-connect-gateway")
  throw new Error("Only the product gateway executable can be packaged");
const [os, cpu] = platforms[target];
const repo = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(join(repo, "packages/gateway-npm/package.json"), "utf8"),
);
const output = join(repo, "dist/gateway", `${os}-${cpu}`);
await mkdir(join(output, "bin"), { recursive: true });
const dest = join(output, "bin/agent-connect-gateway");
await copyFile(resolve(binary), dest);
await chmod(dest, 0o755);
await writeFile(
  join(output, "package.json"),
  JSON.stringify(
    {
      name: `@open-agent-connect/gateway-${os}-${cpu}`,
      version: manifest.version,
      license: "MIT",
      repository: manifest.repository,
      publishConfig: { access: "public", tag: "next" },
      os: [os],
      cpu: [cpu],
      files: ["bin", "LICENSE", "README.md", "SHA256SUMS"],
      exports: { "./bin/agent-connect-gateway": "./bin/agent-connect-gateway" },
    },
    null,
    2,
  ),
);
await copyFile(join(repo, "LICENSE"), join(output, "LICENSE"));
await writeFile(
  join(output, "README.md"),
  `# Agent Connect gateway ${os}/${cpu}\n\nPlatform executable for @open-agent-connect/gateway ${manifest.version}.\nACP/MCP-over-ACP are unstable. Install the launcher package for CLI usage.\n`,
);
await writeFile(
  join(output, "SHA256SUMS"),
  `${createHash("sha256")
    .update(await readFile(dest))
    .digest("hex")}  bin/agent-connect-gateway\n`,
);
console.log(`Prepared local ${target} npm artifact`);
