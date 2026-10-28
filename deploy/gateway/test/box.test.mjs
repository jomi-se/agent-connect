import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireBoxImage } from "../../../scripts/test-box-images.mjs";
import { seedCodexMock } from "./fixtures/seed-codex.mjs";
const boxImage = requireBoxImage();
test("box starts both CLIs with an unnamed UID and private homes", () => {
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
  assert.match(output, /^codex-cli \S+$/m);
  assert.match(output, /^\S+ \(Claude Code\)$/m);
  assert.equal(
    output.split("\n").filter((line) => line === "700 12345 12345").length,
    2,
  );
});

for (const seeded of [false, true]) {
  test(`production entrypoint ${seeded ? "preserves seeded" : "creates file-backed default"} Codex configuration`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "box-config-test-"));
    const cidFile = join(root, "container-id");
    t.after(async () => {
      try {
        const id = await readFile(cidFile, "utf8").catch((error) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        if (id) {
          assert.match(id, /^[a-f0-9]{64}$/);
          const cleanup = spawnSync("docker", ["rm", "--force", id], {
            encoding: "utf8",
            timeout: 30000,
          });
          assert.ok(
            !cleanup.error &&
              (cleanup.status === 0 ||
                /No such container/.test(cleanup.stderr)),
            "Owned config-test container cleanup failed",
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    if (seeded) await seedCodexMock(home, root);
    const expected = seeded
      ? await readFile(join(home, "codex-home/config.toml"), "utf8")
      : 'cli_auth_credentials_store = "file"\n';
    const output = execFileSync(
      "docker",
      [
        "run",
        "--pull=never",
        "--rm",
        "--cidfile",
        cidFile,
        "--network",
        "none",
        "--read-only",
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--mount",
        `type=bind,src=${home},dst=/home/node`,
        boxImage,
        "sh",
        "-ec",
        'test ! -e /opt/agent-connect/mock-codex-config.toml; cat "$CODEX_HOME/config.toml"',
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(output, expected);
    assert.equal(
      await readFile(join(home, "codex-home/config.toml"), "utf8"),
      expected,
    );
  });
}
