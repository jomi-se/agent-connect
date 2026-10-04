import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// Each local gate owns its listener and results; leave other previews alone.
const port = Number(
  process.env["WEBMCP_PORT"] ??
    execFileSync(
      process.execPath,
      [
        "-e",
        "const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => { process.stdout.write(String(s.address().port)); s.close(); });",
      ],
      { encoding: "utf8" },
    ).trim(),
);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("WEBMCP_PORT must be a TCP port from 1 to 65535");
// Playwright reloads this module in workers. Keep the main process's allocation.
process.env["WEBMCP_PORT"] = String(port);
const outputDir =
  process.env["PLAYWRIGHT_OUTPUT_DIR"] ??
  mkdtempSync(join(tmpdir(), "agent-connect-webmcp-results-"));
process.env["PLAYWRIGHT_OUTPUT_DIR"] = outputDir;

export default defineConfig({
  testDir: "./e2e",
  outputDir,
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: {
      ...(process.env["WEBMCP_CHROMIUM_EXECUTABLE"]
        ? { executablePath: process.env["WEBMCP_CHROMIUM_EXECUTABLE"] }
        : {}),
      args: ["--enable-experimental-web-platform-features"],
    },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npx vite --config packages/web-sdk/vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: new URL("../../", import.meta.url).pathname,
    url: `http://127.0.0.1:${port}/packages/web-sdk/src/index.ts`,
    reuseExistingServer: false,
  },
});
