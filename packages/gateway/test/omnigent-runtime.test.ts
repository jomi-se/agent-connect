import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { OmnigentRuntime } from "../src/omnigent-runtime.js";

describe("OmnigentRuntime sandbox profile", () => {
  it("uploads a linux_bwrap profile with only explicit read/write roots", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-connect-runtime-"));
    let uploadedConfig = "";
    let runnerWorkspace = "";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/v1/sessions" && init?.method === "POST") {
        const form = init.body as FormData;
        const bundle = form.get("bundle") as Blob;
        uploadedConfig = firstTarFile(
          gunzipSync(Buffer.from(await bundle.arrayBuffer())),
        );
        return Response.json({ session_id: "provider-session" });
      }
      if (pathname === "/v1/hosts") {
        return Response.json({
          hosts: [{ host_id: "host-1", status: "online" }],
        });
      }
      if (pathname.endsWith("/runners")) {
        runnerWorkspace = String(
          JSON.parse(String(init?.body ?? "{}"))["workspace"] ?? "",
        );
        return Response.json({});
      }
      if (pathname === "/v1/sessions/provider-session") {
        return Response.json({ runner_online: true });
      }
      return Response.json({}, { status: 404 });
    });
    const runtime = new OmnigentRuntime({
      baseUrl: "http://127.0.0.1:6767",
      workspace,
      fetch,
      sandbox: {
        type: "linux_bwrap",
        codexHome: "/srv/agent-connect/codex-home",
        hostSentinel: "/host-only/agent-connect-sentinel",
        readPaths: ["/srv/agent-connect/node_modules"],
      },
    });
    await expect(
      runtime.createSession({
        appId: "demo",
        origin: "https://app.example",
        toolHash: "hash",
        approvedToolNames: ["write_result", "read_state", "read_state"],
      }),
    ).resolves.toBe("provider-session");
    expect(uploadedConfig).toContain("type: linux_bwrap");
    expect(uploadedConfig).toContain('- "/srv/agent-connect/codex-home"');
    expect(uploadedConfig).toContain('- "/srv/agent-connect/node_modules"');
    expect(uploadedConfig).toContain("allow_network: true");
    expect(uploadedConfig).toContain("AGENT_CONNECT_HOST_SENTINEL");
    expect(uploadedConfig).toContain(
      "The enclosing Omnigent process sandbox, not a nested Codex sandbox",
    );
    expect(uploadedConfig).not.toContain(
      "Agent Connect has not configured an outer OS sandbox",
    );
    expect(uploadedConfig).not.toContain('write_paths:\n      - "."');
    expect(runnerWorkspace).toMatch(
      new RegExp(`^${escapeRegExp(workspace)}/\\.agent-connect-sessions/`),
    );
    await expect(
      readFile(
        join(runnerWorkspace, ".agent-connect", "codex-mcp-policy.json"),
        "utf8",
      ).then((value) => JSON.parse(value)),
    ).resolves.toEqual({
      version: 1,
      toolHash: "hash",
      mcpServer: "omnigent",
      approvedToolNames: ["read_state", "write_result"],
    });
    await rm(workspace, { recursive: true, force: true });
  });

  it("rejects relative sandbox roots", () => {
    expect(
      () =>
        new OmnigentRuntime({
          baseUrl: "http://127.0.0.1:6767",
          workspace: "/workspace",
          sandbox: {
            type: "linux_bwrap",
            codexHome: "relative/home",
            hostSentinel: "/sentinel",
          },
        }),
    ).toThrow("must be absolute");
  });

  it("rejects a sentinel inside any mounted root", () => {
    expect(
      () =>
        new OmnigentRuntime({
          baseUrl: "http://127.0.0.1:6767",
          workspace: "/workspace",
          sandbox: {
            type: "linux_bwrap",
            codexHome: "/private/codex-home",
            hostSentinel: "/workspace/host-sentinel",
          },
        }),
    ).toThrow("host sentinel must be outside");
  });

  it("rejects application tool names reserved by the Omnigent relay", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-connect-runtime-"));
    const runtime = new OmnigentRuntime({
      baseUrl: "http://127.0.0.1:6767",
      workspace,
      fetch: vi.fn(),
    });
    await expect(
      runtime.createSession({
        appId: "demo",
        origin: "https://app.example",
        toolHash: "hash",
        approvedToolNames: ["sys_agent_download"],
      }),
    ).rejects.toThrow("collides with the Omnigent provider");
    await rm(workspace, { recursive: true, force: true });
  });

  it("discloses when the provider profile has no outer OS sandbox", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-connect-runtime-"));
    let uploadedConfig = "";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/v1/sessions" && init?.method === "POST") {
        const bundle = (init.body as FormData).get("bundle");
        if (!(bundle instanceof Blob)) throw new Error("missing bundle");
        uploadedConfig = firstTarFile(
          gunzipSync(Buffer.from(await bundle.arrayBuffer())),
        );
        return Response.json({ session_id: "provider-session" });
      }
      if (pathname === "/v1/hosts") {
        return Response.json({
          hosts: [{ host_id: "host-1", status: "online" }],
        });
      }
      if (pathname.endsWith("/runners")) return Response.json({});
      if (pathname === "/v1/sessions/provider-session") {
        return Response.json({ runner_online: true });
      }
      return new Response("not found", { status: 404 });
    });
    const runtime = new OmnigentRuntime({
      baseUrl: "http://127.0.0.1:6767",
      workspace,
      fetch,
    });
    await runtime.createSession({
      appId: "demo",
      origin: "https://app.example",
      toolHash: "hash",
      approvedToolNames: ["read_state"],
    });
    expect(uploadedConfig).toContain(
      "Agent Connect has not configured an outer OS sandbox for this profile",
    );
    expect(uploadedConfig).toContain(
      "guidance, not a host-enforced confidentiality boundary",
    );
    await rm(workspace, { recursive: true, force: true });
  });

  it("removes the session workspace when provider creation fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-connect-runtime-"));
    const runtime = new OmnigentRuntime({
      baseUrl: "http://127.0.0.1:6767",
      workspace,
      fetch: vi.fn(
        async () => new Response("upstream failed", { status: 500 }),
      ),
    });
    await expect(
      runtime.createSession({
        appId: "demo",
        origin: "https://app.example",
        toolHash: "hash",
        approvedToolNames: ["read_state"],
      }),
    ).rejects.toThrow("Omnigent POST /v1/sessions failed");
    await expect(
      readdir(join(workspace, ".agent-connect-sessions")),
    ).resolves.toEqual([]);
    await rm(workspace, { recursive: true, force: true });
  });
});

function firstTarFile(tar: Buffer): string {
  const sizeText = tar
    .subarray(124, 136)
    .toString("ascii")
    .replaceAll("\0", "")
    .trim();
  const size = Number.parseInt(sizeText, 8);
  return tar.subarray(512, 512 + size).toString("utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("OmnigentRuntime session teardown", () => {
  function stubServer(
    options: { readonly workspaceFromSnapshot?: boolean } = {},
  ) {
    const calls: Array<{ method: string; pathname: string }> = [];
    let runnerWorkspace = "";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      calls.push({ method, pathname });
      if (pathname === "/v1/sessions" && method === "POST") {
        return Response.json({ session_id: "provider-session" });
      }
      if (pathname === "/v1/hosts") {
        return Response.json({
          hosts: [{ host_id: "host-1", status: "online" }],
        });
      }
      if (pathname.endsWith("/runners")) {
        runnerWorkspace = String(
          JSON.parse(String(init?.body ?? "{}"))["workspace"] ?? "",
        );
        return Response.json({});
      }
      if (pathname === "/v1/sessions/provider-session") {
        if (method === "DELETE") return Response.json({ deleted: true });
        return Response.json({
          runner_online: true,
          status: "idle",
          total_cost_usd: 0.125,
          last_total_tokens: 4242,
          context_window: 200000,
          ...(options.workspaceFromSnapshot
            ? { workspace: runnerWorkspace }
            : {}),
        });
      }
      return Response.json({}, { status: 404 });
    });
    return { fetch, calls, workspace: () => runnerWorkspace };
  }

  it("deletes the provider session and removes the session workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-connect-runtime-"));
    const server = stubServer();
    const runtime = new OmnigentRuntime({
      baseUrl: "http://127.0.0.1:6767",
      workspace,
      fetch: server.fetch,
    });
    const providerSessionId = await runtime.createSession({
      appId: "demo",
      origin: "https://app.example",
      toolHash: "hash",
      approvedToolNames: ["write_result"],
    });
    expect(
      await readdir(join(workspace, ".agent-connect-sessions")),
    ).toHaveLength(1);

    await runtime.destroySession(providerSessionId);

    expect(
      server.calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.pathname === "/v1/sessions/provider-session",
      ),
    ).toBe(true);
    // The runner is torn down by the provider; the session workspace is the
    // gateway's own and has to be removed here or it accumulates per session.
    expect(await readdir(join(workspace, ".agent-connect-sessions"))).toEqual(
      [],
    );
    await rm(workspace, { recursive: true, force: true });
  });

  it("refuses to delete a workspace outside the session root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-connect-runtime-"));
    const outsider = await mkdtemp(join(tmpdir(), "agent-connect-outside-"));
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/v1/sessions/provider-session") {
        if (init?.method === "DELETE") return Response.json({});
        // A compromised or simply wrong provider must not be able to point
        // teardown at an arbitrary path on the host.
        return Response.json({ runner_online: true, workspace: outsider });
      }
      return Response.json({}, { status: 404 });
    });
    const runtime = new OmnigentRuntime({
      baseUrl: "http://127.0.0.1:6767",
      workspace,
      fetch,
    });
    await runtime.destroySession("provider-session");
    expect(await readdir(outsider)).toEqual([]);
    await rm(workspace, { recursive: true, force: true });
    await rm(outsider, { recursive: true, force: true });
  });

  it("reports cumulative usage for the operator console", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-connect-runtime-"));
    const server = stubServer();
    const runtime = new OmnigentRuntime({
      baseUrl: "http://127.0.0.1:6767",
      workspace,
      fetch: server.fetch,
    });
    expect(await runtime.describeSession("provider-session")).toEqual({
      status: "idle",
      runnerOnline: true,
      totalCostUsd: 0.125,
      totalTokens: 4242,
      contextWindow: 200000,
    });
    await rm(workspace, { recursive: true, force: true });
  });
});
