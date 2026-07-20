#!/usr/bin/env node

import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CREATE_SERVER_CONFIG = "this.createMcpSeverConfig(mcp.server)";

export function patchCodexAcpSource(source, policyModuleUrl) {
  if (!source.startsWith("#!/usr/bin/env node\n")) {
    throw new Error("Unsupported codex-acp bundle: missing Node shebang");
  }
  const occurrences = source.split(CREATE_SERVER_CONFIG).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Unsupported codex-acp bundle: expected one MCP configuration seam, found ${occurrences}`,
    );
  }
  const importLine = `import { applyAgentConnectMcpPolicy } from ${JSON.stringify(policyModuleUrl)};\n`;
  return source
    .replace("#!/usr/bin/env node\n", `#!/usr/bin/env node\n${importLine}`)
    .replace(
      CREATE_SERVER_CONFIG,
      `applyAgentConnectMcpPolicy(projectPath, mcp.name, ${CREATE_SERVER_CONFIG})`,
    );
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    throw new Error(
      "Usage: prepare-codex-acp-adapter.mjs <upstream-dist> <output>",
    );
  }
  const policyModuleUrl = pathToFileURL(
    resolve(new URL("codex-acp-tool-policy.mjs", import.meta.url).pathname),
  ).href;
  const patched = patchCodexAcpSource(
    await readFile(resolve(input), "utf8"),
    policyModuleUrl,
  );
  await writeFile(resolve(output), patched, { encoding: "utf8", mode: 0o700 });
  await chmod(resolve(output), 0o700);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
