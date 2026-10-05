import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { requireBoxImage } from "../../../scripts/test-box-images.mjs";
const boxImage = requireBoxImage();
test("box starts both pinned CLIs with an unnamed UID and private homes", () => {
  const output = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "12345:12345",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--tmpfs",
      "/home/node:rw,exec,uid=12345,gid=12345",
      "--tmpfs",
      "/work:rw,exec,uid=12345,gid=12345",
      "--tmpfs",
      "/tmp:rw,exec",
      boxImage,
      "sh",
      "-c",
      'codex --version && claude --version && stat -c "%a %u %g" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR"',
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.match(output, /codex-cli 0\.159\.2/);
  assert.match(output, /2\.1\.286/);
  assert.equal(
    output.split("\n").filter((line) => line === "700 12345 12345").length,
    2,
  );
});
