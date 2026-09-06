// Real compiled plugin + patched host. Only Tailscale and inference are fixtures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startOpenClawTestRuntime } from "./openclaw-test-runtime.mjs";

test("compiled plugin consent issues a token accepted by native Responses", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "ac-consent-fixture-"));
  const cli = join(fixture, "tailscale");
  const endpoint = join(fixture, "endpoint");
  await writeFile(
    cli,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
if (a[0] === 'version') console.log('1.99.0-test');
else if (a[0] === 'serve' && a[1] === 'status') console.log('{}');
else if (a[0] === 'status') console.log(JSON.stringify({Self:{DNSName:'openclaw.test.',TailscaleIPs:['100.64.0.1']}}));
else if (a[0] === 'whois') console.log(JSON.stringify({UserProfile:{LoginName:'owner@example.test',DisplayName:'Fixture Owner'}}));
else if (a[0] === 'serve' && a.includes('--bg=false') && /^\\d+$/.test(a.at(-1))) {
  writeFileSync(${JSON.stringify(endpoint)}, a.at(-1));
  console.log('Press Ctrl+C to exit.');
  setInterval(() => {}, 60000);
} else { console.error('Unsupported fixture CLI invocation'); process.exit(2); }
`,
  );
  await chmod(cli, 0o700);
  let runtime;
  const issuer = "https://openclaw.test";
  const app = "https://bookhand.example";
  const resource = `${issuer}/v1/responses`;
  const tool = {
    name: "lookup_book",
    description: "Find a book",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
  };
  try {
    runtime = await startOpenClawTestRuntime({
      tailscaleTestBinary: cli,
      onModelRequest(body, inference) {
        assert.deepEqual(
          body.tools?.map((t) => t.function?.name ?? t.name),
          [tool.name],
        );
        if (JSON.stringify(body.messages).includes("book-id-42"))
          inference.text("Received book-id-42.");
        else inference.tool(tool.name, { title: "Flatland" });
      },
      async configure(config, { directory }) {
        const workspace = join(directory, "application-workspace");
        await mkdir(workspace, { recursive: true });
        config.gateway.tailscale = { mode: "serve", resetOnExit: false };
        config.gateway.auth.allowTailscale = true;
        config.gateway.roles = {
          default: "denied",
          definitions: {
            denied: { sessions: { others: "none" }, agents: [], scopes: [] },
            owner: {
              sessions: { others: "write" },
              agents: "*",
              scopes: ["operator.admin"],
            },
            "app-only": {
              sessions: { others: "none" },
              sandbox: "inherit",
              agents: ["restricted"],
              scopes: [],
            },
          },
        };
        config.agents.entries = {
          restricted: {
            workspace,
            contextInjection: "never",
            model: { primary: "fixture/fixture" },
            tools: { deny: ["*"] },
          },
        };
        config.plugins = {
          allow: ["agent-connect-openclaw"],
          load: { paths: [resolve("dist/openclaw-plugin")] },
          entries: {
            "agent-connect-openclaw": {
              enabled: true,
              config: {
                issuer,
                resource,
                statePath: join(directory, "grants.json"),
                ownerProfileIds: ["fixture-owner"],
                policies: [
                  {
                    ref: "app-only",
                    label: "Application tools only",
                    agentId: "restricted",
                    nativeCapabilities: [],
                  },
                ],
              },
            },
          },
        };
      },
    });
    const sourceRoot = resolve(".agent-connect/openclaw-app-principal-work");
    const schemaSource = await readFile(
      join(sourceRoot, "src/state/user-profiles-schema.ts"),
      "utf8",
    );
    const schema = schemaSource.match(
      /const USER_PROFILES_SCHEMA_SQL = `([\s\S]*?)`;/,
    )?.[1];
    assert.ok(schema, "pinned owner schema fixture must be available");
    const dbPath = join(runtime.directory, "state/state/openclaw.sqlite");
    await mkdir(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(schema);
      db.prepare(
        "INSERT INTO user_profiles(id,display_name,role,created_at,updated_at) VALUES(?,?,?,?,?)",
      ).run("fixture-owner", "Fixture Owner", "owner", Date.now(), Date.now());
      db.prepare(
        "INSERT INTO user_profile_emails(email,profile_id,created_at) VALUES(?,?,?)",
      ).run("owner@example.test", "fixture-owner", Date.now());
    } finally {
      db.close();
    }
    let port;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        port = (await readFile(endpoint, "utf8")).trim();
        break;
      } catch {
        await delay(250);
      }
    }
    assert.match(port ?? "", /^\d+$/, "managed ingress listener must start");
    const ingress = `http://127.0.0.1:${port}`;
    const ownerHeaders = {
      host: "openclaw.test",
      "x-forwarded-host": "openclaw.test",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "100.64.0.10",
      "tailscale-user-login": "owner@example.test",
    };
    const form = async (base, path, fields, headers = {}) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body: new URLSearchParams(fields),
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
    const verifier = "fixture-verifier-".repeat(4);
    const par = await form(
      runtime.baseUrl,
      "/agent-connect/oauth/par",
      {
        client_id: app,
        redirect_uri: `${app}/callback`,
        response_type: "code",
        scope: "responses",
        resource,
        state: "fixture-state",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        authorization_details: JSON.stringify([
          { type: "agent_connect", application_tools: [tool] },
        ]),
      },
      { origin: app },
    );
    assert.equal(par.status, 201, await par.clone().text());
    const { request_uri } = await par.json();
    const path = `/agent-connect/oauth/authorize?${new URLSearchParams({ client_id: app, request_uri })}`;
    const forged = await fetch(`${runtime.baseUrl}${path}`, {
      headers: ownerHeaders,
    });
    assert.equal(
      forged.status,
      401,
      "ordinary listener must reject forged identity headers",
    );
    const shown = await fetch(`${ingress}${path}`, { headers: ownerHeaders });
    const html = await shown.text();
    assert.equal(shown.status, 200, html);
    const csrf = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
    assert.ok(csrf, "owner consent form must issue CSRF token");
    const allowed = await form(
      ingress,
      "/agent-connect/oauth/authorize",
      { request_uri, csrf_token: csrf, decision: "allow", policy_choice: "0" },
      { ...ownerHeaders, origin: issuer },
    );
    assert.equal(allowed.status, 303, await allowed.clone().text());
    const callback = new URL(allowed.headers.get("location"));
    assert.equal(callback.searchParams.get("iss"), issuer);
    const tokenResponse = await form(
      runtime.baseUrl,
      "/agent-connect/oauth/token",
      {
        grant_type: "authorization_code",
        code: callback.searchParams.get("code"),
        client_id: app,
        redirect_uri: `${app}/callback`,
        resource,
        code_verifier: verifier,
      },
      { origin: app },
    );
    assert.equal(tokenResponse.status, 200, "token exchange must succeed");
    const token = await tokenResponse.json();
    const response = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        origin: app,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openclaw/default",
        stream: false,
        input: "Look up Flatland.",
        tools: [
          {
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    const call = result.output?.find(
      (item) => item.type === "function_call" && item.name === tool.name,
    );
    assert.ok(call);
    const refreshed = await form(
      runtime.baseUrl,
      "/agent-connect/oauth/token",
      {
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: app,
        resource,
      },
      { origin: app },
    );
    assert.equal(refreshed.status, 200, "issued refresh token must rotate");
    const nextToken = await refreshed.json();
    const continued = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${nextToken.access_token}`,
        origin: app,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openclaw/default",
        stream: false,
        previous_response_id: result.id,
        input: [
          {
            type: "function_call_output",
            call_id: call.call_id,
            output: "book-id-42",
          },
        ],
        tools: [
          {
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });
    const final = await continued.json();
    assert.equal(continued.status, 200, JSON.stringify(final));
    assert.equal(final.status, "completed");
    assert.match(JSON.stringify(final.output), /Received book-id-42/);
    assert.equal(runtime.modelRequests.length, 2);
  } finally {
    await runtime?.close();
  }
});
