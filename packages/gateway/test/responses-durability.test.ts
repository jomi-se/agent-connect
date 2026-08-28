import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ResponseEngine, type EngineSession } from "../src/responses/engine.js";
import { ResponseApiError } from "../src/responses/errors.js";
import { FileResponseStore } from "../src/responses/file-store.js";
import type { ParsedResponseRequest } from "../src/responses/profile.js";
import type {
  ResponseResource,
  ResponseStreamEvent,
} from "../src/responses/protocol.js";
import {
  hashToolSnapshot,
  validateToolSnapshot,
} from "../src/tool-snapshot.js";
import { FakeBackend, type FakeTurn } from "./support/fake-backend.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-connect-responses-"));
  directories.push(directory);
  return directory;
}

const tools = validateToolSnapshot([
  {
    name: "set_page_message",
    description: "Replace the visible page message",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
]);

const session: EngineSession = {
  sessionId: "acs_1",
  appId: "canvas",
  origin: "https://app.example",
  toolHash: hashToolSnapshot(tools),
  tools,
  authorizationGrantId: "grant_1",
  providerSessionId: "provider_1",
};

const initial: ParsedResponseRequest = {
  kind: "initial",
  stream: true,
  prompt: "hello",
};

function engineOn(directory: string, turns: readonly FakeTurn[]) {
  const store = new FileResponseStore(directory);
  const backend = new FakeBackend({ turns });
  return {
    store,
    backend,
    engine: new ResponseEngine({
      store,
      backend,
      isGrantActive: () => true,
    }),
  };
}

async function drain(
  stream: AsyncGenerator<ResponseStreamEvent>,
): Promise<ResponseResource> {
  let final: ResponseResource | undefined;
  for await (const event of stream) {
    if ("response" in event) final = event.response;
  }
  if (!final) throw new Error("the segment produced no terminal event");
  return final;
}

function callIdOf(resource: ResponseResource): string {
  const item = resource.output.at(-1);
  if (!item || item.type !== "function_call") {
    throw new Error("expected the response to end with a function call");
  }
  return item.call_id;
}

describe("file-backed response store", () => {
  it("recovers after one durable write failure without exposing phantom state", async () => {
    const directory = stateDirectory();
    const first = engineOn(directory, [[{ type: "completed" }]]);
    await drain(await first.engine.createResponse(session, initial));
    const [original] = await first.store.listChains();
    expect(original).toBeDefined();

    let failNext = true;
    const store = new FileResponseStore(directory, {
      durableWrite: (path, body) => {
        if (failNext) {
          failNext = false;
          throw new Error("transient disk failure");
        }
        writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
      },
    });
    const phantom = { ...original!, updatedAt: original!.updatedAt + 1 };
    await expect(store.putChain(phantom)).rejects.toThrow(
      "transient disk failure",
    );
    expect(await store.getChain(original!.chainId)).toEqual(original);

    const recovered = { ...original!, updatedAt: original!.updatedAt + 2 };
    await store.putChain(recovered);
    expect(await store.getChain(original!.chainId)).toEqual(recovered);
    expect(
      JSON.parse(
        readFileSync(join(directory, `${original!.chainId}.json`), "utf8"),
      ).chain.updatedAt,
    ).toBe(recovered.updatedAt);
  });

  it("persists a published call before the process that published it is gone", async () => {
    const directory = stateDirectory();
    const first = engineOn(directory, [
      [
        {
          type: "tool.call",
          providerToken: "provider_a",
          name: "set_page_message",
          arguments: '{"message":"hi"}',
        },
      ],
    ]);
    const created = await drain(
      await first.engine.createResponse(session, initial),
    );
    const callId = callIdOf(created);

    // Everything below reads only what reached disk.
    const files = readdirSync(directory).filter((name) =>
      name.endsWith(".json"),
    );
    expect(files).toHaveLength(1);
    const raw = JSON.parse(
      readFileSync(join(directory, files[0] ?? ""), "utf8"),
    ) as {
      chain: { status: string; authorizationGrantId: string; origin: string };
      calls: Record<
        string,
        { publication: string; result: string; providerToken: string }
      >;
    };
    expect(raw.chain.status).toBe("waiting_for_output");
    // The fields a restarted gateway needs to prove who authorized the chain.
    expect(raw.chain.authorizationGrantId).toBe("grant_1");
    expect(raw.chain.origin).toBe("https://app.example");
    expect(raw.calls[callId]).toMatchObject({
      publication: "published",
      result: "none",
      providerToken: "provider_a",
    });
  });

  it("reconstructs a completed response after a restart", async () => {
    const directory = stateDirectory();
    const first = engineOn(directory, [
      [{ type: "text.delta", delta: "done" }, { type: "completed" }],
    ]);
    const completed = await drain(
      await first.engine.createResponse(session, initial),
    );

    // A new engine over the same directory stands in for a restarted gateway:
    // it shares no process memory with the one that produced the response.
    const restarted = engineOn(directory, []);
    const view = await restarted.engine.describeChain(session, completed.id);
    expect(view.recovery).toBe("terminal_reconstructed");
    expect(view.response.status).toBe("completed");
    expect(view.response.output).toEqual(completed.output);
    // The immutable snapshot is rendered from the durable record, not memory.
    expect(view.response.tools).toEqual(completed.tools);
  });

  it("resolves a chain parked across a restart as interrupted", async () => {
    const directory = stateDirectory();
    const first = engineOn(directory, [
      [
        {
          type: "tool.call",
          providerToken: "provider_a",
          name: "set_page_message",
          arguments: "{}",
        },
      ],
    ]);
    const created = await drain(
      await first.engine.createResponse(session, initial),
    );
    const callId = callIdOf(created);

    const restarted = engineOn(directory, []);
    // The published call is still redeliverable from the durable ledger, which
    // is the only source of truth for it: the harness snapshot never reports a
    // parked call.
    // A restarted engine has no live harness run. It must retire the chain
    // before offering the side effect for redelivery.
    expect(
      await restarted.engine.pendingFunctionCalls(session, created.id),
    ).toEqual([]);

    // But the parked awaiter lived in the harness process, so the chain cannot
    // continue. It resolves to the declared terminal outcome, not a hang and
    // not a silently replaced provider session.
    const view = await restarted.engine.describeChain(session, created.id);
    expect(view.recovery).toBe("terminal_reconstructed");
    await expect(
      restarted.engine.createResponse(session, {
        kind: "continuation",
        stream: true,
        previousResponseId: created.id,
        callId,
        output: "{}",
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable" });
  });

  it("refuses a chain whose grant was revoked while the gateway was down", async () => {
    const directory = stateDirectory();
    const first = engineOn(directory, [
      [{ type: "text.delta", delta: "done" }, { type: "completed" }],
    ]);
    const completed = await drain(
      await first.engine.createResponse(session, initial),
    );

    const store = new FileResponseStore(directory);
    const revoked = new ResponseEngine({
      store,
      backend: new FakeBackend({ turns: [] }),
      isGrantActive: () => false,
    });
    await expect(
      revoked.describeChain(session, completed.id),
    ).rejects.toBeInstanceOf(ResponseApiError);
  });

  it("fails startup loudly when a chain file is corrupt", async () => {
    const directory = stateDirectory();
    const first = engineOn(directory, [[{ type: "completed" }]]);
    const completed = await drain(
      await first.engine.createResponse(session, initial),
    );
    rmSync(join(directory, "not-a-chain.json"), { force: true });
    writeFileSync(join(directory, "not-a-chain.json"), "{ broken", "utf8");

    expect(() => engineOn(directory, [])).toThrow("Cannot load response state");
    expect(completed.status).toBe("completed");
  });
});
