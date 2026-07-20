import { readFileSync } from "node:fs";
import { join } from "node:path";

const POLICY_PATH = [".agent-connect", "codex-mcp-policy.json"];
// Keep this aligned with the gateway's public tool-snapshot grammar.
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const RESERVED_OMNIGENT_TOOLS = new Set([
  "download_file",
  "list_comments",
  "list_files",
  "load_skill",
  "read_skill_file",
  "update_comment",
  "upload_file",
  "web_fetch",
  "web_search",
]);

export function isReservedOmnigentToolName(name) {
  return (
    name.startsWith("sys_") ||
    name.startsWith("hindsight_") ||
    RESERVED_OMNIGENT_TOOLS.has(name)
  );
}

/**
 * Merge an Agent Connect grant-derived policy into one dynamically supplied
 * Codex MCP server. Invalid manifests fail session creation instead of falling
 * back to a broader approval policy.
 */
export function applyAgentConnectMcpPolicy(
  projectPath,
  serverName,
  transportConfig,
) {
  const manifestPath = join(projectPath, ...POLICY_PATH);
  let raw;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return transportConfig;
    throw new Error(`Agent Connect could not read ${manifestPath}`, {
      cause: error,
    });
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Agent Connect found invalid JSON in ${manifestPath}`, {
      cause: error,
    });
  }
  if (
    manifest?.version !== 1 ||
    typeof manifest.mcpServer !== "string" ||
    typeof manifest.toolHash !== "string" ||
    !Array.isArray(manifest.approvedToolNames) ||
    manifest.approvedToolNames.length === 0 ||
    manifest.approvedToolNames.length > 256 ||
    !manifest.approvedToolNames.every(
      (name) =>
        typeof name === "string" &&
        TOOL_NAME.test(name) &&
        !isReservedOmnigentToolName(name),
    )
  ) {
    throw new Error(
      `Agent Connect found an invalid tool policy in ${manifestPath}`,
    );
  }

  if (manifest.mcpServer !== serverName) return transportConfig;

  const approvedToolNames = [...new Set(manifest.approvedToolNames)].sort();
  process.stderr.write(
    `Agent Connect: pre-approving ${approvedToolNames.length} granted ${serverName} tools for snapshot ${manifest.toolHash}\n`,
  );
  return {
    ...transportConfig,
    enabled_tools: approvedToolNames,
    default_tools_approval_mode: "prompt",
    tools: Object.fromEntries(
      approvedToolNames.map((name) => [name, { approval_mode: "approve" }]),
    ),
  };
}
