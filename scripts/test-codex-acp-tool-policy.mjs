import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { applyAgentConnectMcpPolicy } from "./codex-acp-tool-policy.mjs";
import { patchCodexAcpSource } from "./prepare-codex-acp-adapter.mjs";

const workspace = await mkdtemp(join(tmpdir(), "agent-connect-policy-"));
try {
  const transport = { command: "relay", args: [], env: {} };
  assert.equal(
    applyAgentConnectMcpPolicy(workspace, "omnigent", transport),
    transport,
  );

  const policyDirectory = join(workspace, ".agent-connect");
  await mkdir(policyDirectory);
  await writeFile(
    join(policyDirectory, "codex-mcp-policy.json"),
    JSON.stringify({
      version: 1,
      toolHash: "sha256:test",
      mcpServer: "omnigent",
      approvedToolNames: ["write_result", "_read_state", "_read_state"],
    }),
  );
  assert.deepEqual(
    applyAgentConnectMcpPolicy(workspace, "omnigent", transport),
    {
      ...transport,
      enabled_tools: ["_read_state", "write_result"],
      default_tools_approval_mode: "prompt",
      tools: {
        _read_state: { approval_mode: "approve" },
        write_result: { approval_mode: "approve" },
      },
    },
  );

  await writeFile(
    join(policyDirectory, "codex-mcp-policy.json"),
    JSON.stringify({
      version: 1,
      toolHash: "sha256:test",
      mcpServer: "omnigent",
      approvedToolNames: ["sys_agent_download"],
    }),
  );
  assert.throws(
    () => applyAgentConnectMcpPolicy(workspace, "omnigent", transport),
    /invalid tool policy/,
  );

  const fixture = `#!/usr/bin/env node\nconst value = this.createMcpSeverConfig(mcp.server);\n`;
  const patched = patchCodexAcpSource(
    fixture,
    pathToFileURL("/tmp/policy.mjs").href,
  );
  assert.match(patched, /applyAgentConnectMcpPolicy\(projectPath, mcp\.name,/);
  assert.throws(
    () => patchCodexAcpSource("#!/usr/bin/env node\n", "file:///policy.mjs"),
    /expected one MCP configuration seam/,
  );

  const pinnedBundle = await readFile(
    new URL(
      "../node_modules/@agentclientprotocol/codex-acp/dist/index.js",
      import.meta.url,
    ),
    "utf8",
  );
  const patchedPinnedBundle = patchCodexAcpSource(
    pinnedBundle,
    pathToFileURL("/tmp/policy.mjs").href,
  );
  assert.equal(
    patchedPinnedBundle.match(/applyAgentConnectMcpPolicy\(projectPath/g)
      ?.length,
    1,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}

console.log("codex-acp tool policy checks passed");
