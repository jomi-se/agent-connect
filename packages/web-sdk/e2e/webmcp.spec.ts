import { expect, test } from "@playwright/test";
import type {
  AgentProvider,
  AgentProviderTaskRequest,
  ApplicationToolContext,
  JsonObject,
} from "../src/index.js";

// The native Chromium 153 binding is intentionally distinct from the CG draft.
interface NativeTool {
  name: string;
  description: string;
  inputSchema?: object;
  execute(
    input: JsonObject,
    options: { signal: AbortSignal },
  ): Promise<unknown>;
}
interface NativeContext extends EventTarget {
  registerTool(
    tool: NativeTool,
    options?: { signal: AbortSignal },
  ): Promise<void>;
  getTools(): Promise<
    Array<{ name: string; inputSchema?: string; window: Window }>
  >;
}
type NativeDocument = Document & { modelContext: NativeContext };

const sdkPath = "/packages/web-sdk/src/index.ts";
const invocation: ApplicationToolContext = {
  connectionId: "browser-fixture",
  toolName: "fixture",
  actionId: "fixture-action",
  meta: null,
};

test.beforeEach(async ({ page }) => {
  // Real secure localhost document; only the empty HTML fixture is intercepted.
  await page.route("**/webmcp-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>WebMCP SDK fixture</title>",
    }),
  );
  await page.goto("/webmcp-fixture");
  expect(
    await page.evaluate(
      () => typeof (document as NativeDocument).modelContext?.getTools,
    ),
  ).toBe("function");
});

test("discovers immutable native definitions, selects names and excludes frames", async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ sdkPath }) => {
      const { createWebMcpToolSnapshot } = (await import(
        sdkPath
      )) as typeof import("../src/index.js");
      const mc = (document as NativeDocument).modelContext;
      const schema = {
        type: "object",
        properties: { value: { type: "string" } },
      };
      await mc.registerTool({
        name: "local",
        description: "Local tool",
        inputSchema: schema,
        execute: async () => null,
      });
      await mc.registerTool({
        name: "no_schema",
        description: "No arguments",
        execute: async () => null,
      });
      const frame = document.createElement("iframe");
      const loaded = new Promise<void>(
        (resolve) => (frame.onload = () => resolve()),
      );
      frame.srcdoc = "<!doctype html>";
      document.body.append(frame);
      await loaded;
      await (frame.contentDocument as NativeDocument).modelContext.registerTool(
        { name: "child", description: "Child tool", execute: async () => null },
      );
      const nativeNames = (await mc.getTools()).map((tool) => tool.name);
      const snapshot = await createWebMcpToolSnapshot();
      const selected = await createWebMcpToolSnapshot({ toolNames: ["local"] });
      schema.properties.value.type = "number";
      const result = {
        nativeNames,
        names: snapshot.tools.map((tool) => tool.name),
        selected: selected.tools.map((tool) => tool.name),
        schema: selected.tools[0]!.inputSchema,
        noSchema: snapshot.tools.find((tool) => tool.name === "no_schema")!
          .inputSchema,
        frozen: [
          snapshot,
          snapshot.tools,
          selected.tools[0],
          selected.tools[0]!.inputSchema,
          selected.tools[0]!.inputSchema["properties"],
        ].every(Object.isFrozen),
      };
      snapshot.dispose();
      selected.dispose();
      return result;
    },
    { sdkPath },
  );
  expect(result.nativeNames).toContain("child");
  expect(result.names).toEqual(["local", "no_schema"]);
  expect(result.selected).toEqual(["local"]);
  expect(result.schema).toEqual({
    type: "object",
    properties: { value: { type: "string" } },
  });
  expect(result.noSchema).toEqual({ type: "object" });
  expect(result.frozen).toBe(true);
});

for (const scenario of [
  "empty",
  "unknown",
  "duplicate",
  "unsupported",
  "inactive",
] as const) {
  test(`fails clearly for ${scenario} discovery`, async ({ page }) => {
    const result = await page.evaluate(
      async ({ sdkPath, scenario }) => {
        const { createWebMcpToolSnapshot } = (await import(
          sdkPath
        )) as typeof import("../src/index.js");
        const error = async (operation: () => Promise<unknown>) => {
          try {
            await operation();
            return "unexpected success";
          } catch (cause) {
            return cause instanceof Error ? cause.message : String(cause);
          }
        };
        if (scenario === "empty")
          return error(() => createWebMcpToolSnapshot());
        if (scenario === "unsupported")
          return error(() =>
            createWebMcpToolSnapshot({
              document: { defaultView: window } as Document,
            }),
          );
        if (scenario === "inactive")
          return error(() =>
            createWebMcpToolSnapshot({
              document: document.implementation.createHTMLDocument(),
            }),
          );
        await (document as NativeDocument).modelContext.registerTool({
          name: "local",
          description: "Local tool",
          execute: async () => null,
        });
        return error(() =>
          createWebMcpToolSnapshot({
            toolNames: scenario === "unknown" ? ["absent"] : ["local", "local"],
          }),
        );
      },
      { sdkPath, scenario },
    );
    expect(result).toContain(
      {
        empty: "No WebMCP tools selected",
        unknown: "not owned by this document",
        duplicate: "Duplicate",
        unsupported: "Native document.modelContext",
        inactive: "Native document.modelContext",
      }[scenario],
    );
  });
}

test("runs native tools through AgentSession, preserving results and validating arguments", async ({
  page,
}) => {
  const result = await page.evaluate(async (sdkPath) => {
    const { AgentSession, createWebMcpToolSnapshot } = (await import(
      sdkPath
    )) as typeof import("../src/index.js");
    const mc = (document as NativeDocument).modelContext;
    let count = 0;
    await mc.registerTool({
      name: "increment",
      description: "Increment local count",
      inputSchema: {
        type: "object",
        properties: { amount: { type: "integer" } },
        required: ["amount"],
        additionalProperties: false,
      },
      execute: async (input) => ({
        count: (count += input["amount"] as number),
      }),
    });
    await mc.registerTool({
      name: "reject",
      description: "Reject execution",
      execute: async () => {
        throw new Error("Deliberate native rejection");
      },
    });
    const snapshot = await createWebMcpToolSnapshot();
    const outputs: Array<{ token: string; output: string }> = [];
    const requests: AgentProviderTaskRequest[] = [];
    const provider: AgentProvider = {
      async *streamTask(request) {
        requests.push(request);
        for (const [token, name, arguments_] of [
          ["valid", "increment", { amount: 3 }],
          ["invalid", "increment", { amount: "wrong" }],
          ["reject", "reject", {}],
          ["explicit", "explicit", {}],
        ] as const) {
          yield {
            type: "tool.requested",
            requestToken: token,
            actionId: token,
            name,
            arguments: arguments_,
          };
        }
        yield { type: "task.completed" };
      },
      async submitToolResult(token, output) {
        outputs.push({ token, output });
      },
      async cancel() {},
    };
    const session = new AgentSession({
      provider,
      tools: [
        ...snapshot.tools,
        {
          name: "explicit",
          description: "Existing explicit tool",
          inputSchema: { type: "object" },
          execute: async () => "explicit-result",
        },
      ],
    });
    await session.runTask("Exercise application tools");
    snapshot.dispose();
    return {
      count,
      outputs,
      names: requests[0]!.tools.map((tool) => tool.name),
    };
  }, sdkPath);
  expect(result.count).toBe(3);
  expect(result.names).toEqual(["increment", "reject", "explicit"]);
  expect(result.outputs[0]).toEqual({ token: "valid", output: '{"count":3}' });
  expect(result.outputs[1]!.output).toContain("invalid_tool_arguments");
  expect(result.outputs[2]!.output).toContain("tool_execution_failed");
  expect(result.outputs[3]).toEqual({
    token: "explicit",
    output: "explicit-result",
  });
});

test("chat stop aborts native execution without invalidating its borrowed snapshot", async ({
  page,
}) => {
  const result = await page.evaluate(async (sdkPath) => {
    const { AgentSession, createAgentChat, createWebMcpToolSnapshot } =
      (await import(sdkPath)) as typeof import("../src/index.js");
    const mc = (document as NativeDocument).modelContext;
    let started!: () => void;
    let aborted!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const nativeAbort = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let calls = 0;
    await mc.registerTool({
      name: "pending",
      description: "A cooperatively cancellable native tool",
      execute: async (_, { signal }) => {
        calls++;
        if (calls > 1) return "reused";
        return new Promise<string>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted();
              resolve("late cancelled output");
            },
            { once: true },
          );
          started();
        });
      },
    });
    const snapshot = await createWebMcpToolSnapshot();
    const outputs: string[] = [];
    let cancellations = 0;
    // A controlled Agent Connect lifecycle fixture, not a provider simulation.
    const makeProvider = (cancelled: boolean): AgentProvider => ({
      async *streamTask() {
        yield {
          type: "tool.requested",
          requestToken: "call",
          actionId: "action",
          name: "pending",
          arguments: {},
        };
        if (cancelled) yield { type: "task.cancelled" };
        else yield { type: "task.completed" };
      },
      async submitToolResult(_token, output) {
        outputs.push(output);
      },
      async cancel() {
        cancellations++;
      },
    });
    const chat = createAgentChat({
      session: new AgentSession({
        provider: makeProvider(true),
        tools: snapshot.tools,
      }),
    });
    const sending = chat.send("Start native tool");
    await ready;
    await chat.stop();
    await nativeAbort;
    const stopped = await sending;
    const afterStop = chat.getSnapshot();
    const cancelledOutputs = [...outputs];
    await chat.dispose();
    const snapshotStillActive = !snapshot.signal.aborted;
    const reused = createAgentChat({
      session: new AgentSession({
        provider: makeProvider(false),
        tools: snapshot.tools,
      }),
    });
    const completed = await reused.send("Reuse approved snapshot");
    await reused.dispose();
    snapshot.dispose();
    return {
      calls,
      cancellations,
      cancelledOutputs,
      outputs,
      snapshotStillActive,
      stopped,
      afterStop,
      completed,
    };
  }, sdkPath);
  expect(result.calls).toBe(2);
  expect(result.cancellations).toBe(1);
  expect(result.cancelledOutputs).toEqual([]);
  expect(result.outputs).toEqual(["reused"]);
  expect(result.snapshotStillActive).toBe(true);
  expect(result.stopped.status).toBe("cancelled");
  expect(result.stopped.parts).toMatchObject([
    { type: "tool", status: "interrupted" },
  ]);
  expect(result.afterStop.status).toBe("idle");
  expect(result.completed.status).toBe("completed");
});

test("removal permanently invalidates consent even after same-name restoration", async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ sdkPath, invocation }) => {
      const { createWebMcpToolSnapshot } = (await import(
        sdkPath
      )) as typeof import("../src/index.js");
      const mc = (document as NativeDocument).modelContext;
      let calls = 0;
      const tool = {
        name: "local",
        description: "Local tool",
        execute: async () => ++calls,
      };
      const registration = new AbortController();
      await mc.registerTool(tool, { signal: registration.signal });
      const snapshot = await createWebMcpToolSnapshot();
      const invalidated = new Promise<void>((resolve) =>
        snapshot.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      registration.abort();
      await invalidated;
      await mc.registerTool(tool);
      let error = "";
      try {
        await snapshot.tools[0]!.execute({}, invocation);
      } catch (cause) {
        error = (cause as Error).message;
      }
      snapshot.dispose();
      snapshot.dispose();
      return { calls, invalidated: snapshot.signal.aborted, error };
    },
    { sdkPath, invocation },
  );
  expect(result.calls).toBe(0);
  expect(result.invalidated).toBe(true);
  expect(result.error).toContain("rediscover");
});

for (const ending of ["dispose", "caller", "pagehide", "toolchange"] as const) {
  test(`${ending} aborts native pending execution and blocks future dispatch`, async ({
    page,
  }) => {
    const result = await page.evaluate(
      async ({ sdkPath, invocation, ending }) => {
        const { createWebMcpToolSnapshot } = (await import(
          sdkPath
        )) as typeof import("../src/index.js");
        const mc = (document as NativeDocument).modelContext;
        let started!: () => void;
        let aborted!: () => void;
        const ready = new Promise<void>((resolve) => (started = resolve));
        const nativeAbort = new Promise<void>((resolve) => (aborted = resolve));
        let calls = 0;
        await mc.registerTool({
          name: "pending",
          description: "Pending local tool",
          execute: async (_, { signal }) => {
            calls++;
            signal.addEventListener("abort", aborted, { once: true });
            started();
            return new Promise(() => {});
          },
        });
        const caller = new AbortController();
        const snapshot = await createWebMcpToolSnapshot({
          signal: caller.signal,
        });
        const pending = Promise.resolve(
          snapshot.tools[0]!.execute({}, invocation),
        ).then(
          () => "unexpected success",
          (cause: Error) => cause.name,
        );
        await ready;
        if (ending === "dispose") snapshot.dispose();
        else if (ending === "caller") caller.abort();
        else if (ending === "pagehide")
          window.dispatchEvent(new PageTransitionEvent("pagehide"));
        else
          await mc.registerTool({
            name: "new_tool",
            description: "Registry change",
            execute: async () => null,
          });
        const rejected = await pending;
        await nativeAbort;
        let future = "";
        try {
          await snapshot.tools[0]!.execute({}, invocation);
        } catch (cause) {
          future = (cause as Error).message;
        }
        snapshot.dispose();
        return { calls, rejected, future, aborted: snapshot.signal.aborted };
      },
      { sdkPath, invocation, ending },
    );
    expect(result.calls).toBe(1);
    expect(result.rejected).toBe("AbortError");
    expect(result.future).toContain("rediscover");
    expect(result.aborted).toBe(true);
  });
}
