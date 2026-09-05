import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preflightOpenClaw } from "./openclaw-test-runtime.mjs";

export function validateOperatorEnvironment(env) {
  for (const name of [
    "OPENCLAW_BASE_URL",
    "OPENCLAW_TOKEN",
    "OPENCLAW_AGENT_ID",
    "AGENT_CONNECT_STATE_PATH",
    "AGENT_CONNECT_PUBLIC_ENDPOINT",
  ]) {
    if (!env[name]?.trim()) throw new Error(`${name} is required`);
  }
  if (!isAbsolute(env.AGENT_CONNECT_STATE_PATH))
    throw new Error("AGENT_CONNECT_STATE_PATH must be absolute");
  if (
    env.AGENT_CONNECT_RESPONSE_STATE_PATH &&
    !isAbsolute(env.AGENT_CONNECT_RESPONSE_STATE_PATH)
  )
    throw new Error("AGENT_CONNECT_RESPONSE_STATE_PATH must be absolute");
  if (!["127.0.0.1", "::1"].includes(env.AGENT_CONNECT_HOST ?? "127.0.0.1"))
    throw new Error("This launcher requires a loopback AGENT_CONNECT_HOST");
  let upstream;
  try {
    upstream = new URL(env.OPENCLAW_BASE_URL);
  } catch {
    throw new Error("OPENCLAW_BASE_URL must be a valid URL");
  }
  if (
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    upstream.pathname !== "/"
  )
    throw new Error(
      "OPENCLAW_BASE_URL must be an origin without credentials, path, query or fragment",
    );
  if (
    upstream.protocol !== "https:" &&
    !(
      upstream.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(upstream.hostname)
    )
  )
    throw new Error(
      "OPENCLAW_BASE_URL requires HTTPS unless upstream is loopback",
    );
  if (!/^[a-zA-Z0-9_-]+$/.test(env.OPENCLAW_AGENT_ID))
    throw new Error("OPENCLAW_AGENT_ID must be an explicit simple agent id");
}

async function main() {
  preflightOpenClaw();
  const action = process.argv[2] ?? "serve";
  if (
    process.argv.length > 3 ||
    !["check", "initialize", "serve"].includes(action)
  )
    throw new Error(
      "Usage: node scripts/openclaw-gateway.mjs [check|initialize|serve]",
    );
  const envFile = process.env.AGENT_CONNECT_OPENCLAW_ENV_FILE;
  if (envFile) {
    if (!isAbsolute(envFile))
      throw new Error("AGENT_CONNECT_OPENCLAW_ENV_FILE must be absolute");
    if (process.platform !== "win32" && (statSync(envFile).mode & 0o077) !== 0)
      throw new Error(
        "Operator env file must not be accessible to group or others (chmod 600)",
      );
    process.loadEnvFile(envFile);
  }
  validateOperatorEnvironment(process.env);
  const filename = action === "initialize" ? "initialize-main.js" : "main.js";
  const entry = new URL(
    `../packages/gateway/dist/${filename}`,
    import.meta.url,
  );
  if (!existsSync(entry))
    throw new Error(
      "Gateway build missing; run npm run build --workspace @agent-connect/gateway",
    );
  if (
    action !== "initialize" &&
    !existsSync(process.env.AGENT_CONNECT_STATE_PATH)
  )
    throw new Error(
      "Gateway identity missing; initialize a NEW profile explicitly, or select the existing identity path",
    );
  if (
    action === "initialize" &&
    existsSync(process.env.AGENT_CONNECT_STATE_PATH)
  )
    throw new Error(
      "Gateway identity already exists; refusing to reinitialize",
    );
  if (action !== "initialize") {
    try {
      const response = await fetch(
        new URL("/health", process.env.OPENCLAW_BASE_URL),
        {
          headers: { authorization: `Bearer ${process.env.OPENCLAW_TOKEN}` },
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        },
      );
      await response.body?.cancel();
      if (!response.ok) throw new Error("unhealthy");
    } catch {
      throw new Error(
        "OpenClaw health check failed; check the private service and operator configuration (upstream response suppressed)",
      );
    }
  }
  if (action === "check") {
    console.log(
      "Agent Connect operator configuration, build, identity and upstream health checks passed. Runtime/tool compatibility requires the integration test and selected-runtime smoke.",
    );
    return;
  }
  await import(entry.href);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    // Validation errors name fields only, never configuration values or upstream bodies.
    console.error(`Agent Connect startup failed: ${error.message}`);
    process.exitCode = 78;
  });
}
