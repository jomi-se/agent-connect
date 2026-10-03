import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: { entries: ["packages/web-sdk/src/index.ts"] },
});
