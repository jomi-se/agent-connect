import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponseEngine, type EngineSession } from "../src/responses/engine.js";
import { OpenClawResponses } from "../src/responses/openclaw.js";
import { FileResponseStore } from "../src/responses/file-store.js";
import {
  InMemoryResponseStore,
  type ChainRecord,
  type ResponseRecord,
  type CallRecord,
} from "../src/responses/store.js";
import { hashToolSnapshot } from "../src/tool-snapshot.js";

const roots: string[] = [];
function directory() {
  const root = mkdtempSync(join(tmpdir(), "ac-authority-fault-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const session: EngineSession = {
  sessionId: "acs_local",
  appId: "test",
  origin: "https://app.example",
  tools: [],
  toolHash: hashToolSnapshot([]),
  authorizationGrantId: "grant_local",
  providerSessionId: "agent:main:openresponses:private_local",
};
const chain: ChainRecord = {
  chainId: "chain_local",
  appSessionId: session.sessionId,
  appId: session.appId,
  origin: session.origin,
  authorizationGrantId: session.authorizationGrantId,
  toolHash: session.toolHash,
  tools: [],
  providerKind: "openclaw",
  providerSessionId: session.providerSessionId,
  sessionTurn: 1,
  continuedFromResponseId: null,
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  latestResponseId: null,
  terminalError: null,
};
function engine(
  store: FileResponseStore,
  fetch: typeof globalThis.fetch,
  isGrantActive = () => true,
) {
  return new ResponseEngine({
    store,
    upstream: new OpenClawResponses({
      baseUrl: "http://127.0.0.1:1",
      token: "private",
      agentId: "main",
      fetch,
    }),
    isGrantActive,
  });
}
describe("AC-owned durable authority faults (not provider compatibility)", () => {
  it.each(["memory", "file"])(
    "atomically rejects foreign response/call ownership in %s storage",
    async (kind) => {
      const store =
        kind === "file"
          ? new FileResponseStore(directory())
          : new InMemoryResponseStore();
      await store.putChain(chain);
      await store.putChain({
        ...chain,
        chainId: "chain_foreign",
        appSessionId: "acs_foreign",
      });
      const response: ResponseRecord = {
        responseId: "resp_collision",
        chainId: chain.chainId,
        previousResponseId: null,
        status: "completed",
        createdAt: 1,
        completedAt: 1,
        output: [],
        error: null,
      };
      const call: CallRecord = {
        callId: "call_collision",
        chainId: chain.chainId,
        responseId: response.responseId,
        providerToken: "call_collision",
        name: "set_page_message",
        arguments: "{}",
        publication: "published",
        result: "none",
        output: null,
        outputFingerprint: null,
        createdAt: 1,
        updatedAt: 1,
      };
      await store.putResponse(response);
      await store.putCall(call);
      await expect(
        store.putResponse({ ...response, chainId: "chain_foreign" }),
      ).rejects.toThrow();
      await expect(
        store.putCall({ ...call, chainId: "chain_foreign" }),
      ).rejects.toThrow();
      expect(await store.getResponse(response.responseId)).toEqual(response);
      expect(await store.getCall(call.callId)).toEqual(call);
    },
  );

  it("keeps durable retirement and rolls back a failed write without phantom state", async () => {
    const path = directory();
    let fail = false;
    const store = new FileResponseStore(path, {
      durableWrite(file, body) {
        if (fail) throw new Error("disk full");
        writeFileSync(file, body);
      },
    });
    await store.putChain(chain);
    await store.retireSession("acs_retired");
    fail = true;
    await expect(store.putChain({ ...chain, updatedAt: 2 })).rejects.toThrow(
      "disk full",
    );
    expect(await store.getChain(chain.chainId)).toEqual(chain);
    const restarted = new FileResponseStore(path);
    expect(await restarted.getChain(chain.chainId)).toEqual(chain);
    expect(await restarted.isSessionRetired("acs_retired")).toBe(true);
  });
  it("does not contact upstream when admission cannot be made durable", async () => {
    const store = new FileResponseStore(directory(), {
      durableWrite() {
        throw new Error("disk full");
      },
    });
    const upstream = vi.fn<typeof fetch>();
    await expect(
      engine(store, upstream).createResponse(session, {
        kind: "initial",
        stream: true,
        prompt: "hello",
      }),
    ).rejects.toThrow("disk full");
    expect(upstream).not.toHaveBeenCalled();
    expect(await store.listChains()).toEqual([]);
  });
  it("persists uncertain network acceptance and never retries after restart", async () => {
    const path = directory();
    const store = new FileResponseStore(path);
    const upstream = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("connection reset after write"));
    await expect(
      engine(store, upstream).createResponse(session, {
        kind: "initial",
        stream: true,
        prompt: "hello",
      }),
    ).rejects.toBeDefined();
    expect(upstream).toHaveBeenCalledTimes(1);
    const [persisted] = await store.listChains();
    expect(persisted).toMatchObject({
      status: "terminal",
      terminalError: { code: "backend_unavailable" },
    });
    const restarted = engine(new FileResponseStore(path), upstream);
    await expect(
      restarted.createResponse(session, {
        kind: "initial",
        stream: true,
        prompt: "retry",
      }),
    ).rejects.toMatchObject({ code: "previous_response_not_continuable" });
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("rechecks consent after asynchronous durable admission before network delivery", async () => {
    const store = new FileResponseStore(directory());
    let active = true;
    const original = store.putChain.bind(store);
    store.putChain = async (value) => {
      await original(value);
      active = false;
    };
    const upstream = vi.fn<typeof fetch>();
    await expect(
      engine(store, upstream, () => active).createResponse(session, {
        kind: "initial",
        stream: true,
        prompt: "revoked while writing",
      }),
    ).rejects.toMatchObject({ code: "response_cancelled" });
    expect(upstream).not.toHaveBeenCalled();
  });
});
