// Explicit operator smoke: existing Codex OAuth is read by OpenClaw at runtime only.
// No login, credential copy, refresh request, model fallback, or API-key environment.
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { openSync, closeSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import http from "node:http";
import { compatibility, preflightOpenClaw } from "./openclaw-test-runtime.mjs";

const binary = preflightOpenClaw();
const root = process.argv[2];
const codexHome = process.argv[3];
const resume = process.argv[4] === "--resume";
const startOnly = process.argv[5] === "--start-verified";
const verifiedEvidence = process.argv[6];
if (
  startOnly &&
  (!resume || !verifiedEvidence || !isAbsolute(verifiedEvidence))
)
  throw new Error(
    "--start-verified requires --resume and an absolute successful conversation evidence directory",
  );
if (resume && existsSync(join(root, "summary.json"))) {
  const prior = JSON.parse(await readFile(join(root, "summary.json"), "utf8"));
  let running = false;
  try {
    process.kill(prior.pid, 0);
    running = true;
  } catch {
    /* stopped profile */
  }
  if (running)
    throw new Error(
      "Profile already has a running upstream; refusing to modify or restart it",
    );
}
if (
  !root ||
  !isAbsolute(root) ||
  (existsSync(root) && !resume) ||
  !codexHome ||
  !isAbsolute(codexHome)
)
  throw new Error(
    "Usage: node scripts/openclaw-subscription-smoke.mjs NEW_ABSOLUTE_PROFILE EXISTING_CODEX_HOME [--resume after explicit operator review]",
  );
const sourcePath = join(codexHome, "auth.json");
const originalAuth = await readFile(sourcePath);
let credentials;
try {
  credentials = JSON.parse(originalAuth);
} catch {
  throw new Error(
    "Existing source auth file is malformed; no credential content will be printed",
  );
}
const access = credentials.tokens?.access_token;
if (
  credentials.auth_mode !== "chatgpt" ||
  credentials.OPENAI_API_KEY ||
  !access ||
  !credentials.tokens?.refresh_token
)
  throw new Error(
    "Existing source must contain ChatGPT OAuth only; no login or API-key fallback attempted",
  );
let expires;
try {
  expires =
    JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString()).exp *
    1000;
} catch {
  throw new Error("Source access expiry is unreadable; no refresh attempted");
}
if (!Number.isFinite(expires) || expires < Date.now() + 600000)
  throw new Error(
    "Source access credential is expired or too near expiry; stop for operator direction, never refresh here",
  );
const fingerprint = (value) => createHash("sha256").update(value).digest("hex");
await mkdir(dirname(root), { recursive: true, mode: 0o700 });
if (!resume) await mkdir(root, { mode: 0o700 });
const evidence = resume ? join(root, `attempt-${Date.now()}`) : root;
if (resume) await mkdir(evidence, { mode: 0o700 });
const previousConfig = resume
  ? JSON.parse(await readFile(join(root, "openclaw.json"), "utf8"))
  : undefined;
const env = {
  PATH: process.env.PATH,
  CODEX_HOME: codexHome,
  OPENCLAW_HOME: root,
  OPENCLAW_STATE_DIR: join(root, "state"),
  OPENCLAW_CONFIG_PATH: join(root, "openclaw.json"),
  XDG_CACHE_HOME: join(root, "cache"),
  TMPDIR: root,
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
};
const installedVersion = execFileSync(binary, ["--version"], {
  env,
  encoding: "utf8",
  timeout: 30000,
});
if (
  !new RegExp(`\\b${compatibility.version.replaceAll(".", "\\.")}\\b`).test(
    installedVersion,
  )
)
  throw new Error("Installed OpenClaw version differs from reviewed pin");
const portProbe = http.createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const port = previousConfig?.gateway.port ?? portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const token =
  previousConfig?.gateway.auth.token ?? randomBytes(32).toString("hex");
await writeFile(join(root, "gateway-token"), token, { mode: 0o600 });
const config = {
  gateway: {
    mode: "local",
    bind: "loopback",
    port,
    auth: { mode: "token", token },
    http: { endpoints: { responses: { enabled: true } } },
  },
  auth: {
    profiles: { "openai:default": { provider: "openai", mode: "oauth" } },
    order: { openai: ["openai:default"] },
  },
  agents: {
    defaults: {
      workspace: join(root, "workspace"),
      skipBootstrap: true,
      heartbeat: { every: "0m" },
      timeoutSeconds: 90,
      model: { primary: "openai/gpt-5.6-sol", fallbacks: [] },
      models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } } },
    },
  },
  tools: { deny: ["*"] },
  plugins: {
    slots: { memory: "none" },
    entries: { "memory-core": { enabled: false } },
  },
  logging: { file: join(evidence, "openclaw.log") },
};
await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2), {
  mode: 0o600,
});
const log = openSync(join(evidence, "upstream.log"), "a", 0o600);
let child;
let successful = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function auditCredentials() {
  const sensitive = [
    credentials.tokens.access_token,
    credentials.tokens.refresh_token,
    credentials.tokens.id_token,
  ].filter(Boolean);
  const leaked = [];
  const managedOAuthProfiles = [];
  const { DatabaseSync } = await import("node:sqlite");
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        if (sensitive.some((value) => bytes.includes(Buffer.from(value))))
          leaked.push(path.slice(root.length + 1));
        // Exclusively held *.lock.sqlite files carry lock ownership, never auth stores.
        if (/(?:^|\/)(?:openclaw|openclaw-agent)\.sqlite$/.test(path)) {
          const db = new DatabaseSync(path, { readOnly: true });
          try {
            const tables = db
              .prepare("SELECT name FROM sqlite_master WHERE type='table'")
              .all()
              .map((row) => row.name);
            const stores = [];
            if (tables.includes("auth_profile_store"))
              stores.push(
                ...db
                  .prepare(
                    "SELECT store_json AS payload FROM auth_profile_store",
                  )
                  .all(),
              );
            if (tables.includes("config_machine_state"))
              stores.push(
                ...db
                  .prepare(
                    "SELECT value_json AS payload FROM config_machine_state WHERE state_key='authProfiles.store'",
                  )
                  .all(),
              );
            for (const row of stores)
              for (const [id, profile] of Object.entries(
                JSON.parse(row.payload).profiles ?? {},
              )) {
                if (
                  profile.provider === "openai" &&
                  (profile.access || profile.refresh || profile.idToken)
                )
                  managedOAuthProfiles.push({
                    file: path.slice(root.length + 1),
                    profile: id,
                  });
              }
          } finally {
            db.close();
          }
        }
      }
    }
  }
  await visit(root);
  const unchanged =
    fingerprint(await readFile(sourcePath)) === fingerprint(originalAuth);
  const audit = {
    sourceUnchanged: unchanged,
    persistedSourceCredentialFiles: leaked,
    managedOAuthProfiles,
    source: "CODEX_HOME/auth.json",
    auth: "ChatGPT OAuth runtime-only bootstrap",
    accessExpiry: new Date(expires).toISOString(),
  };
  await writeFile(
    join(evidence, "credential-audit.json"),
    JSON.stringify(audit, null, 2),
    { mode: 0o600 },
  );
  if (!unchanged || leaked.length || managedOAuthProfiles.length)
    throw new Error(
      "Credential invariant failed; service stopped, inspect credential-audit.json privately",
    );
  return audit;
}
try {
  await auditCredentials();
  child = spawn(binary, ["gateway", "run", "--port", String(port)], {
    env,
    stdio: ["ignore", log, log],
    detached: true,
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null)
      throw new Error("OpenClaw startup failed; private log retained");
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* startup only; no model retry */
    }
    await delay(500);
  }
  if (!ready) throw new Error("OpenClaw startup timeout");
  if (startOnly) {
    const prior = async (name) =>
      JSON.parse(
        await readFile(join(verifiedEvidence, `${name}.json`), "utf8"),
      );
    const [initial, continuation, followup, audit] = await Promise.all(
      ["initial", "continuation", "followup", "credential-audit"].map(prior),
    );
    const label = followup.response.output
      .flatMap((item) => item.content ?? [])
      .map((item) => item.text ?? "")
      .join("\n")
      .trim();
    if (
      ![initial, continuation, followup].every(
        (item) => item.status === 200 && item.response.status === "completed",
      ) ||
      !initial.response.output.some(
        (item) => item.name === "read_library_shelf_label",
      ) ||
      !/^Orchard shelf \d+ violet$/.test(label) ||
      !JSON.stringify(continuation.response.output).includes(label) ||
      !audit.sourceUnchanged ||
      audit.persistedSourceCredentialFiles.length ||
      audit.managedOAuthProfiles.length
    )
      throw new Error(
        "Prior conversation evidence does not establish the selected subscription smoke",
      );
    if (
      /embeddings|billing_not_active/.test(
        await readFile(join(verifiedEvidence, "upstream.log"), "utf8"),
      )
    )
      throw new Error("Prior profile used auxiliary embeddings");
  } else {
    const sessionKey = `agent:main:openresponses:subscription-smoke-${randomUUID()}`;
    const tools = [
      {
        type: "function",
        name: "read_library_shelf_label",
        description:
          "Read the public display label on a library shelf. This is ordinary book-catalog data, not a credential or security value.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ];
    async function response(body, label) {
      const result = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-openclaw-agent-id": "main",
          "x-openclaw-session-key": sessionKey,
        },
        body: JSON.stringify({ model: "openclaw", tools, ...body }),
        signal: AbortSignal.timeout(110000),
      });
      const value = await result.json();
      await writeFile(
        join(evidence, `${label}.json`),
        JSON.stringify({ status: result.status, response: value }, null, 2),
        { mode: 0o600 },
      );
      if (result.status !== 200 || value.status !== "completed")
        throw new Error(
          `${label} failed; no retry/login/refresh/fallback attempted; inspect private artifact`,
        );
      return value;
    }
    const initial = await response(
      {
        input:
          "Call read_library_shelf_label once to read the library's current public shelf label. After receiving it, tell me exactly which shelf to visit. Do not invent a label.",
      },
      "initial",
    );
    const calls = initial.output.filter(
      (item) => item.type === "function_call",
    );
    if (calls.length !== 1 || calls[0].name !== "read_library_shelf_label")
      throw new Error("Expected one approved application function; no retry");
    // Generate only after the actual tool call: model cannot know this from the initial prompt.
    const applicationValue = `Orchard shelf ${10000 + (randomBytes(4).readUInt32BE() % 90000)} violet`;
    const continuation = await response(
      {
        previous_response_id: initial.id,
        input: [
          {
            type: "function_call_output",
            call_id: calls[0].call_id,
            output: JSON.stringify({ value: applicationValue }),
          },
        ],
      },
      "continuation",
    );
    const textOf = (value) =>
      value.output
        .flatMap((item) => item.content ?? [])
        .map((item) => item.text ?? "")
        .join("\n");
    if (!textOf(continuation).includes(applicationValue))
      throw new Error("Model did not consume the actual application value");
    const followup = await response(
      {
        previous_response_id: continuation.id,
        input:
          "Which shelf did you just recommend? Repeat its exact public display label, without calling the tool again.",
      },
      "followup",
    );
    if (
      !textOf(followup).includes(applicationValue) ||
      followup.output.some((item) => item.type === "function_call")
    )
      throw new Error(
        "Follow-up did not preserve the private conversation value",
      );
  }
  await auditCredentials();
  const currentLog = await readFile(join(evidence, "upstream.log"), "utf8");
  if (/embeddings|billing_not_active/.test(currentLog))
    throw new Error(
      "Unexpected auxiliary embedding activity; subscription-only profile not proven",
    );
  const summary = {
    ok: true,
    baseUrl,
    agentId: "main",
    selectedModel: "openai/gpt-5.6-sol",
    selectedRuntime: "openclaw",
    authProfile: "openai:default",
    auth: "existing ChatGPT subscription OAuth, runtime-only Codex bootstrap",
    fallbackModels: [],
    apiKeyEnvironment: false,
    memoryPluginsDisabled: true,
    auxiliaryEmbeddingLogEntries: false,
    configPath: env.OPENCLAW_CONFIG_PATH,
    tokenFile: join(root, "gateway-token"),
    evidence,
    ...(startOnly
      ? {
          verifiedConversationEvidence: verifiedEvidence,
          modelCallsThisStart: 0,
        }
      : {}),
    pid: child.pid,
    sourceAccessExpiry: new Date(expires).toISOString(),
    meaningfulToolResultConsumed: true,
    followupPreserved: true,
  };
  await writeFile(
    join(root, "summary.json"),
    JSON.stringify(summary, null, 2),
    { mode: 0o600 },
  );
  successful = true;
  child.unref();
  console.log(JSON.stringify(summary));
} catch (error) {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ ok: false, error: error.message }, null, 2),
    { mode: 0o600 },
  );
  console.error(`Subscription smoke stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (!successful && child?.pid && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    process.kill(-child.pid, "SIGTERM");
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null)
      process.kill(-child.pid, "SIGKILL");
  }
  closeSync(log);
  if (!successful) await auditCredentials();
}
