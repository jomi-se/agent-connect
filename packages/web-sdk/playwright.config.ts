import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4176",
    launchOptions: {
      ...(process.env["WEBMCP_CHROMIUM_EXECUTABLE"]
        ? { executablePath: process.env["WEBMCP_CHROMIUM_EXECUTABLE"] }
        : {}),
      args: ["--enable-experimental-web-platform-features"],
    },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 4176 --strictPort",
    cwd: new URL("../../", import.meta.url).pathname,
    url: "http://127.0.0.1:4176/packages/web-sdk/src/index.ts",
    reuseExistingServer: false,
  },
});
