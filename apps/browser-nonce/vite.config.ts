import { defineConfig } from "vite";

const omnigentTarget = process.env["OMNIGENT_URL"] ?? "http://127.0.0.1:6767";

export default defineConfig({
  server: {
    proxy: {
      "/omnigent": {
        target: omnigentTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/omnigent/, ""),
      },
    },
  },
});
