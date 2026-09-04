import { describe, expect, it, vi } from "vitest";
import { createWebMcpToolSnapshot } from "../src/index.js";

// These fixtures control adapter-owned faults and exact discovery schedules.
// Native browser compatibility lives in e2e/webmcp.spec.ts, never in this double.
function fixture(schema: unknown = '{"type":"object"}') {
  const window = new EventTarget();
  const context = Object.assign(new EventTarget(), {
    getTools: vi.fn(),
    executeTool: vi.fn(async () => "null"),
  });
  const document = {
    defaultView: window,
    location: { origin: "https://app.test" },
    modelContext: context,
  } as unknown as Document;
  Object.assign(window, { document });
  const descriptor = {
    name: "read",
    description: "Read",
    inputSchema: schema,
    window,
    origin: "https://app.test",
  };
  context.getTools.mockResolvedValue([descriptor]);
  return { document, window, context, descriptor };
}

describe("WebMCP adapter faults", () => {
  it("does not access the native API of an inactive document", async () => {
    const document = {
      defaultView: null,
      get modelContext() {
        throw new Error("inactive native getter");
      },
    } as unknown as Document;
    await expect(createWebMcpToolSnapshot({ document })).rejects.toMatchObject({
      code: "webmcp_unavailable",
    });
  });

  it("rejects registry change at the discovery await boundary and releases listeners", async () => {
    const f = fixture();
    let release!: (tools: unknown[]) => void;
    f.context.getTools.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const removed = vi.spyOn(f.context, "removeEventListener");
    const pending = createWebMcpToolSnapshot({ document: f.document });
    f.context.dispatchEvent(new Event("toolchange"));
    release([f.descriptor]);
    await expect(pending).rejects.toMatchObject({
      code: "webmcp_snapshot_invalidated",
    });
    expect(removed).toHaveBeenCalledWith("toolchange", expect.any(Function));
    expect(f.context.executeTool).not.toHaveBeenCalled();
  });

  it.each([
    "not json",
    "null",
    "[]",
    '{"type":"string"}',
    '{"type":"object","required":42}',
  ])(
    "rejects malformed/unsupported schema before consent: %s",
    async (schema) => {
      const f = fixture(schema);
      await expect(
        createWebMcpToolSnapshot({ document: f.document }),
      ).rejects.toBeInstanceOf(Error);
      expect(f.context.executeTool).not.toHaveBeenCalled();
    },
  );

  it("refuses the unvalidated draft object binding without dispatch or retry", async () => {
    const f = fixture({ type: "object" });
    await expect(
      createWebMcpToolSnapshot({ document: f.document }),
    ).rejects.toMatchObject({ code: "webmcp_unavailable" });
    expect(f.context.executeTool).not.toHaveBeenCalled();
  });

  it("does not trust a matching window with a different origin", async () => {
    const f = fixture();
    f.context.getTools.mockResolvedValue([
      { ...f.descriptor, origin: "https://other.test" },
    ]);
    await expect(
      createWebMcpToolSnapshot({ document: f.document }),
    ).rejects.toThrow("No WebMCP tools");
  });

  it("cleans up a failed discovery and honors an already-aborted owner signal", async () => {
    const f = fixture();
    f.context.getTools.mockRejectedValue(new Error("discovery failed"));
    const removed = vi.spyOn(f.window, "removeEventListener");
    await expect(
      createWebMcpToolSnapshot({ document: f.document }),
    ).rejects.toThrow("discovery failed");
    expect(removed).toHaveBeenCalledWith("pagehide", expect.any(Function));
    f.context.getTools.mockClear();
    await expect(
      createWebMcpToolSnapshot({
        document: f.document,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "webmcp_snapshot_invalidated" });
    expect(f.context.getTools).not.toHaveBeenCalled();
  });

  it("clones metadata and schema so later caller mutations do not change approval", async () => {
    const f = fixture('{"type":"object","properties":{"x":{"type":"string"}}}');
    const snapshot = await createWebMcpToolSnapshot({ document: f.document });
    f.descriptor.description = "Changed";
    f.descriptor.inputSchema = '{"type":"object"}';
    const tool = snapshot.tools[0]!;
    expect(tool.description).toBe("Read");
    expect(Object.isFrozen(tool.inputSchema.properties)).toBe(true);
    await tool.execute(
      {},
      { connectionId: "test", toolName: "read", actionId: "a", meta: null },
    );
    expect(f.context.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Read" }),
      "{}",
      { signal: snapshot.signal },
    );
    snapshot.dispose();
  });
});
