import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import { OmnigentRuntime } from "../src/omnigent-runtime.js";

describe("OmnigentRuntime sandbox profile", () => {
  it("uploads a linux_bwrap profile with only explicit read/write roots", async () => {
    let uploadedConfig = "";
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
      if (pathname.endsWith("/runners")) return Response.json({});
      if (pathname === "/v1/sessions/provider-session") {
        return Response.json({ runner_online: true });
      }
      return Response.json({}, { status: 404 });
    });
    const runtime = new OmnigentRuntime({
      baseUrl: "http://127.0.0.1:6767",
      workspace: "/srv/agent-connect/workspace",
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
      }),
    ).resolves.toBe("provider-session");
    expect(uploadedConfig).toContain("type: linux_bwrap");
    expect(uploadedConfig).toContain('- "/srv/agent-connect/codex-home"');
    expect(uploadedConfig).toContain('- "/srv/agent-connect/node_modules"');
    expect(uploadedConfig).toContain("allow_network: true");
    expect(uploadedConfig).toContain("AGENT_CONNECT_HOST_SENTINEL");
    expect(uploadedConfig).not.toContain('write_paths:\n      - "."');
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
