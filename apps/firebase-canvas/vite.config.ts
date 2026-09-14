import { defineConfig } from "vite";

export default defineConfig(() => {
  const allowedHosts = (process.env.AGENT_CONNECT_CANVAS_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  return {
    ...(allowedHosts.length > 0 ? { server: { allowedHosts } } : {}),
  };
});
