import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function loadPrivateEnvironment(env = process.env) {
  const envFile = env.AGENT_CONNECT_OPENCLAW_ENV_FILE;
  if (!envFile) return;
  if (!isAbsolute(envFile)) {
    throw new Error("AGENT_CONNECT_OPENCLAW_ENV_FILE must be absolute");
  }
  if (process.platform !== "win32" && (statSync(envFile).mode & 0o077) !== 0) {
    throw new Error("Operator env file must be mode 600");
  }
  process.loadEnvFile(envFile);
}

async function main() {
  const action = process.argv[2] ?? "serve";
  if (
    process.argv.length > 3 ||
    !["check", "initialize", "serve"].includes(action)
  ) {
    throw new Error(
      "Usage: node scripts/openclaw-scoped-proxy.mjs [check|initialize|serve]",
    );
  }
  loadPrivateEnvironment();
  const compiled = new URL(
    action === "initialize"
      ? "../packages/gateway/dist/scoped-proxy/initialize-main.js"
      : "../packages/gateway/dist/scoped-proxy/main.js",
    import.meta.url,
  );
  if (!existsSync(compiled)) {
    throw new Error(
      "Scoped proxy build missing; run npm run build:scoped-proxy",
    );
  }
  if (action === "initialize") {
    await import(compiled.href);
    return;
  }
  const { scopedProxyConfigFromEnv } =
    await import("../packages/gateway/dist/scoped-proxy/config.js");
  const config = scopedProxyConfigFromEnv();
  if (action === "check") {
    try {
      const health = await fetch(new URL("/health", config.upstreamBaseUrl), {
        headers: { authorization: `Bearer ${config.upstreamToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      await health.body?.cancel();
      if (!health.ok) throw new Error("unhealthy");

      // Stock OpenClaw authenticates the Responses route before parsing JSON.
      // This proves endpoint enablement and exact bearer acceptance without
      // starting inference or creating an upstream conversation.
      const authenticated = await fetch(
        new URL("/v1/responses", config.upstreamBaseUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.upstreamToken}`,
            "content-type": "application/json",
          },
          body: "{",
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        },
      );
      await authenticated.body?.cancel();
      if (authenticated.status !== 400) throw new Error("unauthenticated");
    } catch {
      throw new Error(
        "Stock OpenClaw health/auth check failed (upstream response suppressed)",
      );
    }
    console.log(
      "Scoped proxy build, pinned stock package, static config/policies, owner identity, grants and upstream auth passed. This does not run inference or replace the required deterministic compatibility test.",
    );
    return;
  }
  await import(compiled.href);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      `Agent Connect scoped proxy startup failed: ${
        error instanceof Error ? error.message : "invalid configuration"
      }`,
    );
    process.exitCode = 78;
  });
}
