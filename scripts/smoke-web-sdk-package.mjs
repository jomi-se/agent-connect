#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smokeRoot = join(repoRoot, ".agent-connect", "web-sdk-package-smoke");
const packagesDir = join(smokeRoot, "packages");
const consumerDir = join(smokeRoot, "consumer");
const cacheDir = join(smokeRoot, "npm-cache");
const preparedTarball = process.argv[2] ? resolve(process.argv[2]) : undefined;

rmSync(smokeRoot, { recursive: true, force: true });
mkdirSync(packagesDir, { recursive: true });
mkdirSync(consumerDir, { recursive: true });

requireBrowserSafeSources();
let tarball = preparedTarball;
if (!tarball) {
  const packed = run(
    "npm",
    [
      "pack",
      "--json",
      "--workspace",
      "@open-agent-connect/web",
      "--pack-destination",
      packagesDir,
    ],
    true,
  );
  const packResult = JSON.parse(packed);
  const filename = packResult[0]?.filename;
  if (typeof filename !== "string") {
    throw new Error("npm pack did not report an SDK tarball");
  }
  tarball = join(packagesDir, filename);
}

writeFileSync(
  join(consumerDir, "package.json"),
  JSON.stringify(
    {
      name: "agent-connect-external-consumer-smoke",
      private: true,
      type: "module",
      dependencies: { "@open-agent-connect/web": `file:${tarball}` },
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(consumerDir, "check.mjs"),
  `import * as rootApi from "@open-agent-connect/web";
import * as acpApi from "@open-agent-connect/web/acp";
import { connectAgent, AcpProvider, createAcpChatTransport, createResumableAcpStream, AcpTransportError, defineTool, createWebMcpToolSnapshot, AgentSession, createAgentChat, exportAgentChatMarkdown, createOpenClawConversationClient, getOpenClawConnectionProviderUrl, normalizeOpenClawProviderUrl, parseOpenClawConnection, serializeOpenClawConnection } from "@open-agent-connect/web";

for (const name of ["connectAgent", "AcpProvider", "createAcpChatTransport", "createResumableAcpStream", "AcpTransportError", "createBrowserAcpStream", "McpOverAcpError", "SingleMcpServer", "defineTool", "AgentConnectError", "AgentSession", "createAgentChat", "exportAgentChatMarkdown", "createWebMcpToolSnapshot"]) {
  if (typeof acpApi[name] !== "function" || acpApi[name] !== rootApi[name]) throw new Error("Missing or divergent ACP subpath export: " + name);
}
for (const name of ["OpenClawConnectionError", "beginOpenClawAuthorization", "completeOpenClawAuthorization", "createOpenClawAccessTokenGetter", "discoverOpenClawProvider", "parseOpenClawAuthorizationTransaction", "parseOpenClawConnection", "refreshOpenClawConnection", "revokeOpenClawConnection", "getOpenClawConnectionProviderUrl", "normalizeOpenClawProviderUrl", "serializeOpenClawConnection", "serializeOpenClawAuthorizationTransaction", "OpenClawConversationUnavailableError", "createOpenClawConversationClient", "ResponsesProvider", "createOpenClawResponsesProvider", "createAiSdkApplicationTools", "createAiSdkOpenResponsesGenerationOptions", "createAiSdkOpenResponsesModel", "createAiSdkOpenResponsesPrepareStep", "selectAiSdkOpenResponsesCheckpoint"]) {
  if (typeof rootApi[name] !== "function") throw new Error("Missing compatibility export: " + name);
}

for (const exported of [connectAgent, AcpProvider, createAcpChatTransport, createResumableAcpStream, AcpTransportError]) {
  if (typeof exported !== "function") throw new Error("Missing unstable ACP package export");
}
if (typeof createWebMcpToolSnapshot !== "function") throw new Error("Missing WebMCP export");
if (normalizeOpenClawProviderUrl("https://gateway.example/agent-connect") !== "https://gateway.example/agent-connect") throw new Error("Missing plugin provider layout");
try {
  await createWebMcpToolSnapshot();
  throw new Error("Node should not have native WebMCP");
} catch (error) {
  if (error.code !== "webmcp_unavailable") throw error;
}

const tool = defineTool({
  name: "external_consumer_tool",
  description: "Prove the installed package executes consumer code",
  inputSchema: { type: "object", additionalProperties: false },
  execute: () => "external-consumer-ok",
});
if (tool.name !== "external_consumer_tool") process.exit(1);
const requests = [];
const outputs = [];
const chat = createAgentChat({ session: new AgentSession({
  tools: [tool],
  provider: {
    async *streamTask(request) {
      requests.push(request);
      yield { type: "text.delta", delta: "Study note " };
      yield { type: "tool.requested", requestToken: "r", actionId: "a",
        name: tool.name, arguments: {} };
      yield { type: "text.delta", delta: "complete." };
      yield { type: "task.completed", continuationToken: "opaque-checkpoint" };
    },
    async submitToolResult(token, output) { outputs.push({ token, output }); },
    async cancel() {},
  },
}) });
let changes = 0;
const unsubscribe = chat.subscribe(() => changes++);
await chat.send("Explain");
await chat.send("Follow up");
if (requests[1].continuationToken !== "opaque-checkpoint" ||
    outputs.length !== 2 || changes === 0 ||
    chat.getSnapshot().messages.length !== 4 ||
    !exportAgentChatMarkdown(chat.getSnapshot()).includes("Study note ")) {
  throw new Error("Packed chat consumer did not complete the real SDK tool loop");
}
unsubscribe();
await chat.dispose();
const applicationTools = [];
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("[]"));
let binary = "";
for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
const applicationToolsHash = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const saved = {
  version: 1,
  providerOrigin: "https://gateway.example",
  endpoint: "https://gateway.example/agent-connect/v1/responses",
  clientId: "https://app.example",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: "2099-01-01T00:00:00.000Z",
  refreshTokenExpiresAt: "2099-02-01T00:00:00.000Z",
  model: "openclaw/default",
  applicationTools,
  applicationToolsHash,
};
const restored = await parseOpenClawConnection(JSON.stringify(saved), { clientId: saved.clientId, now: 0 });
if (getOpenClawConnectionProviderUrl(restored) !== "https://gateway.example/agent-connect" || JSON.parse(serializeOpenClawConnection(restored)).endpoint !== saved.endpoint) throw new Error("Packed saved connection helpers failed");
const historyRequests = [];
const conversations = createOpenClawConversationClient({
  connection: restored,
  getAccessToken: async () => "rotated-access",
  fetch: async (input, init) => {
    historyRequests.push({ url: String(input), authorization: new Headers(init.headers).get("authorization") });
    return Response.json({ conversations: [] });
  },
});
if ((await conversations.list()).length !== 0 || historyRequests[0].url !== "https://gateway.example/agent-connect/v1/conversations" || historyRequests[0].authorization !== "Bearer rotated-access") throw new Error("Packed conversation client failed");
process.stdout.write("external-consumer-ok\\n");
`,
);

run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], false, {
  cwd: consumerDir,
});
writeFileSync(
  join(consumerDir, "check.ts"),
  `import {
  connectAgent, AgentSession, createAcpChatTransport, createResumableAcpStream,
  type AcpGrant, type ConnectAgentOptions, type AcpRecovery,
  type ResumableAcpStream, type ResumableAcpStreamOptions,
  type AcpTransportSnapshot, type BrowserAcpStream, type BrowserAcpStreamOptions,
  type AcpChatTransport, type ApplicationTool, type AgentTaskEvent,
} from "@open-agent-connect/web/acp";
import {
  type AcpRecovery as RootRecovery,
  type OpenClawConnection, type ResponsesProviderOptions,
  type AiSdkOpenResponsesModelOptions,
} from "@open-agent-connect/web";

const tools: ApplicationTool[] = [{
  name: "read_selection", description: "Read selected text",
  inputSchema: { type: "object" }, execute: () => "selected text",
}];
export async function connect(grant: AcpGrant) {
  const options: ConnectAgentOptions = {
    grant, tools, onRecovery: (recovery: AcpRecovery) => {
      const root: RootRecovery = recovery;
      console.log(root.sessionId, root.interrupted);
    },
  };
  const provider = await connectAgent(options);
  const session = new AgentSession({ provider, tools });
  const transport: AcpChatTransport = createAcpChatTransport({ provider, tools });
  const recovery: AcpRecovery = await provider.recover();
  for await (const event of session.streamTask("Read")) {
    const typed: AgentTaskEvent = event;
    if (typed.type === "task.failed") console.log(typed.error.code);
  }
  await transport.close();
  provider.close();
  return recovery;
}
export function resume(url: string, options: ResumableAcpStreamOptions) {
  const link: ResumableAcpStream = createResumableAcpStream(url, options);
  const snapshot: AcpTransportSnapshot = link.stats();
  return snapshot;
}
export type LegacyTypes = OpenClawConnection | ResponsesProviderOptions | AiSdkOpenResponsesModelOptions;
export type BrowserTypes = BrowserAcpStream | BrowserAcpStreamOptions;
`,
);
run(
  process.execPath,
  [
    join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
    "--noEmit",
    "--strict",
    "--exactOptionalPropertyTypes",
    "--skipLibCheck",
    "--target",
    "ES2023",
    "--lib",
    "ES2023,DOM,DOM.Iterable",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "check.ts",
  ],
  false,
  { cwd: consumerDir },
);
const result = run("node", ["check.mjs"], true, { cwd: consumerDir }).trim();
if (result !== "external-consumer-ok") {
  throw new Error(`Unexpected consumer result: ${result}`);
}

const installedPackage = JSON.parse(
  readFileSync(
    join(
      consumerDir,
      "node_modules",
      "@open-agent-connect",
      "web",
      "package.json",
    ),
    "utf8",
  ),
);
const installedRoot = join(
  consumerDir,
  "node_modules",
  "@open-agent-connect",
  "web",
);
requirePackedFiles(installedRoot, installedPackage);
requireDeclarationTags(installedRoot);
const installedIndex = readFileSync(
  join(installedRoot, "dist", "index.js"),
  "utf8",
);
const installedAiSdk = readFileSync(
  join(installedRoot, "dist", "ai-sdk.js"),
  "utf8",
);
const installedBootstrap = readFileSync(
  join(installedRoot, "dist", "zod-jitless.js"),
  "utf8",
);
if (
  !Array.isArray(installedPackage.sideEffects) ||
  !installedPackage.sideEffects.includes("./dist/zod-jitless.js") ||
  !installedIndex.startsWith('import "./zod-jitless.js";') ||
  !installedAiSdk.startsWith('import "./zod-jitless.js";') ||
  !/^import "\.\/zod-jitless\.js";$/m.test(
    readFileSync(join(installedRoot, "dist", "acp.js"), "utf8"),
  ) ||
  !installedBootstrap.includes("jitless: true")
) {
  throw new Error("Packed SDK omitted its CSP-safe Zod bootstrap");
}
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    package: installedPackage.name,
    version: installedPackage.version,
    consumer: "clean npm tarball install",
  })}\n`,
);

function run(command, args, capture = false, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cacheDir },
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    if (capture) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result.stdout ?? "";
}

/**
 * The browser SDK must not reach for a Node built-in. The package tsconfig
 * omits Node types, which catches globals; this catches an explicit
 * `node:` import, which would only fail once a bundler tried to resolve it.
 */
function requireBrowserSafeSources() {
  const sourceRoot = join(repoRoot, "packages", "web-sdk", "src");
  const offenders = [];
  for (const entry of readdirSync(sourceRoot, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const path = join(entry.parentPath ?? sourceRoot, entry.name);
    if (nodeImports(readFileSync(path, "utf8")).length > 0) {
      offenders.push(path);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Browser SDK sources import Node built-ins: ${offenders.join(", ")}`,
    );
  }
}

function nodeImports(source) {
  const builtins = new Set(
    builtinModules.map((name) => name.replace(/^node:/, "")),
  );
  return [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g,
    ),
  ]
    .map((match) => match[1])
    .filter((name) => name.startsWith("node:") || builtins.has(name));
}

function requirePackedFiles(packageRoot, manifest) {
  for (const entry of readdirSync(packageRoot, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const relative = path.slice(packageRoot.length + 1).replaceAll("\\", "/");
    if (
      !["package.json", "README.md", "LICENSE", "CHANGELOG.md"].includes(
        relative,
      ) &&
      !/^dist\/[^/]+\.(?:js|d\.ts)$/.test(relative)
    ) {
      throw new Error(`Unexpected packed SDK file: ${relative}`);
    }
    if (!relative.startsWith("dist/")) continue;
    const source = readFileSync(path, "utf8");
    if (
      /sourceMappingURL|\/home\/|\/Users\//.test(source) ||
      nodeImports(source).length > 0
    ) {
      throw new Error(
        `Packed browser SDK has source maps, local paths or Node imports: ${relative}`,
      );
    }
  }
  for (const name of [".", "./acp"]) {
    const entry = manifest.exports?.[name];
    if (!entry?.types || !entry.import)
      throw new Error(`Missing packed entry point: ${name}`);
    readFileSync(join(packageRoot, entry.types), "utf8");
    readFileSync(join(packageRoot, entry.import), "utf8");
  }
}

function requireDeclarationTags(packageRoot) {
  const legacy = new Set([
    "openclaw-connection",
    "openclaw-conversations",
    "responses-provider",
    "ai-sdk",
  ]);
  const experimental = new Set([
    "acp-provider",
    "acp-chat-transport",
    "resumable-acp-stream",
    "transport",
    "webmcp",
  ]);
  for (const name of [
    ...legacy,
    ...experimental,
    "types",
    "single-mcp-server",
    "agent-chat",
  ]) {
    const path = join(packageRoot, "dist", `${name}.d.ts`);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const declaration of source.statements) {
      if (
        !declaration.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      )
        continue;
      const exportedName = declaration.name?.text;
      const expected =
        legacy.has(name) || exportedName === "ResponsesProviderOptions"
          ? "deprecated"
          : experimental.has(name) ||
              [
                "McpContent",
                "SingleMcpServerOptions",
                "BrowserAcpStreamOptions",
                "BrowserAcpStream",
                "AcpPlanEntry",
                "AcpToolUpdate",
                "McpOverAcpError",
                "SingleMcpServer",
                "AgentChatThoughtPart",
                "AgentChatPlanPart",
                "AgentChatProgressPart",
              ].includes(exportedName)
            ? "experimental"
            : undefined;
      if (
        expected &&
        !ts
          .getJSDocTags(declaration)
          .some((tag) => tag.tagName.text === expected)
      ) {
        throw new Error(
          `Packed declaration omitted @${expected}: ${exportedName}`,
        );
      }
    }
  }
}
