// Explicit gate selection. A supplied artifact must never fall back to debug output.
import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";

export async function gatewayTestBinary({
  repository,
  env = process.env,
  build,
} = {}) {
  const mode = env.ACP_GATEWAY_MODE;
  if (mode !== undefined && mode !== "release-artifacts")
    throw new Error(`Invalid ACP_GATEWAY_MODE: ${mode}`);
  if (env.ACP_GATEWAY_BIN !== undefined) {
    const binary = env.ACP_GATEWAY_BIN;
    if (!binary || !isAbsolute(binary))
      throw new Error("ACP_GATEWAY_BIN must be an absolute executable path");
    if (!(await lstat(binary)).isFile())
      throw new Error("ACP_GATEWAY_BIN must be a regular file, not a link");
    await access(binary, constants.X_OK);
    return binary;
  }
  if (mode === "release-artifacts")
    throw new Error(
      "Release-artifact mode requires ACP_GATEWAY_BIN; source fallback is forbidden",
    );
  if (build) await build();
  return join(repository, "target/debug/agent-connect");
}
