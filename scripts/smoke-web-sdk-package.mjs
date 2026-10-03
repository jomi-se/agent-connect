// Verify the actual npm artifact in a clean consumer, including the browser boundary.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { builtinModules } from "node:module";
const repo = resolve(import.meta.dirname, "..");
const run = mkdtempSync(join(tmpdir(), "agent-connect-sdk-package-"));
function command(bin, args, cwd = run) {
  const result = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(run, "cache") },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${bin} failed (${result.status}): ${result.stderr.slice(-6000)}`,
    );
  return result.stdout;
}
try {
  let tarball = process.argv[2] && resolve(process.argv[2]);
  if (!tarball) {
    const packed = JSON.parse(
      command(
        "npm",
        [
          "pack",
          "--json",
          "--workspace",
          "@open-agent-connect/web",
          "--pack-destination",
          run,
        ],
        repo,
      ),
    );
    tarball = join(run, packed[0].filename);
  }
  const consumer = join(run, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@open-agent-connect/web": `file:${tarball}` },
    }),
  );
  command(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    consumer,
  );
  const installed = join(consumer, "node_modules/@open-agent-connect/web");
  const manifest = JSON.parse(
    readFileSync(join(installed, "package.json"), "utf8"),
  );
  const sourceManifest = JSON.parse(
    readFileSync(join(repo, "packages/web-sdk/package.json"), "utf8"),
  );
  assert.equal(manifest.version, sourceManifest.version);
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  const dist = join(installed, "dist");
  const expected = [
    "index",
    "acp-provider",
    "acp-pairing",
    "acp-chat-transport",
    "acp-tool-executor",
    "errors",
    "resumable-acp-stream",
    "transport",
    "single-mcp-server",
    "types",
    "webmcp",
    "tool-schema",
    "draft7-meta-schema",
    "zod-jitless",
  ];
  assert.deepEqual(
    readdirSync(dist).sort(),
    expected.flatMap((name) => [`${name}.js`, `${name}.d.ts`]).sort(),
  );
  const builtins = new Set(
    builtinModules.map((name) => name.replace(/^node:/, "")),
  );
  for (const file of readdirSync(dist)) {
    const source = readFileSync(join(dist, file), "utf8");
    assert.doesNotMatch(source, /sourceMappingURL|\/home\/|\/Users\//);
    for (const match of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g,
    ))
      assert.ok(
        !match[1].startsWith("node:") && !builtins.has(match[1]),
        `Node import in ${file}`,
      );
  }
  writeFileSync(
    join(consumer, "check.mjs"),
    `import assert from "node:assert/strict";
import * as api from "@open-agent-connect/web";
const expected = ${JSON.stringify(["connectAgent", "AcpProvider", "createAcpChatTransport", "createAcpPairing", "AcpPairing", "AcpPairingError", "captureAcpPairingCallback", "createResumableAcpStream", "AcpTransportError", "createBrowserAcpStream", "McpOverAcpError", "SingleMcpServer", "defineTool", "AgentConnectError", "createWebMcpToolSnapshot"])};
assert.deepEqual(Object.keys(api).sort(), expected.sort());
assert.ok(import.meta.resolve("@open-agent-connect/web").endsWith("/dist/index.js"));
assert.throws(() => import.meta.resolve("@open-agent-connect/web/acp"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
const tool = api.defineTool({ name: "read", description: "Read one value", inputSchema: {type:"object"}, execute: () => "value" });
assert.equal(tool.execute({}, {}), "value");
const error = new api.AgentConnectError("task_busy", "busy", {status:409});
assert.equal(error.status,409);
`,
  );
  command(process.execPath, ["check.mjs"], consumer);
  writeFileSync(
    join(consumer, "check.ts"),
    `import { connectAgent, createAcpChatTransport, defineTool, type AcpProvider, type ApplicationTool } from "@open-agent-connect/web";
const tools: ApplicationTool[] = [defineTool({name:"read",description:"Read",inputSchema:{type:"object"},execute:()=>"value"})];
async function connect() { const provider: AcpProvider = await connectAgent({gatewayUrl:"https://gateway.example", tools}); return createAcpChatTransport({provider,tools}); }
`,
  );
  command(
    process.execPath,
    [
      join(repo, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--skipLibCheck",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "check.ts",
    ],
    consumer,
  );
  assert.ok(
    readFileSync(join(dist, "index.js"), "utf8").includes(
      'import "./zod-jitless.js";',
    ),
  );
  console.log(
    `Packed root ACP SDK ${manifest.version}: runtime, types, exports and browser files passed`,
  );
} finally {
  rmSync(run, { recursive: true, force: true });
}
