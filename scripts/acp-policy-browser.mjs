// Real-adapter policy gate: isolated browser RPCs and deterministic inference.
// Host authority is never exercised; tool drift stops the scripted tool turn.
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const definitions = JSON.parse(
  await readFile(
    new URL(
      "../deploy/acp-gateway/test/fixtures/web/tools.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const browser = await chromium.launch();
const page = await browser.newPage();
const report = { scenario: "policy" };
try {
  await page.goto(process.env.PAGE_ORIGIN);
  // Oversized initial attachment data is rejected before any ACP host exists.
  Object.assign(
    report,
    await page.evaluate(async () => {
      const target = new URLSearchParams(location.search).get("gateway");
      const socket = new WebSocket(target, [
        "agent-connect.resume.v1",
        "bearer.spike-dev-token",
      ]);
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("oversized initial frame did not terminate"));
        }, 10000);
        let opened = false;
        socket.onerror = () => {
          if (!opened) {
            clearTimeout(timer);
            reject(new Error("oversized frame socket failed before open"));
          }
        };
        socket.onopen = () => {
          opened = true;
          socket.send("😀".repeat(262145));
        }; // 1 MiB + 4 UTF-8 bytes
        socket.onclose = ({ code }) => {
          clearTimeout(timer);
          resolve({ oversizedInitialCode: code });
        };
      });
    }),
  );
  Object.assign(
    report,
    await page.evaluate(async (tools) => {
      const target = new URLSearchParams(location.search).get("gateway");
      const socket = new WebSocket(target, [
        "acp.v1",
        "bearer.spike-dev-token",
      ]);
      let serial = 0;
      const waiting = new Map();
      const observed = {
        connects: [],
        listCalls: 0,
        toolCalls: [],
        answer: "",
        denied: {},
      };
      const send = (value) =>
        socket.send(JSON.stringify({ jsonrpc: "2.0", ...value }));
      const request = (method, params) =>
        new Promise((resolve, reject) => {
          const id = ++serial;
          const timer = setTimeout(() => {
            waiting.delete(id);
            reject(new Error(`RPC timed out: ${method}`));
          }, 60000);
          waiting.set(id, (value) => {
            clearTimeout(timer);
            resolve(value);
          });
          send({ id, method, params });
        });
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (!message.method) {
          waiting.get(message.id)?.(message);
          waiting.delete(message.id);
          return;
        }
        if (message.method === "session/update") {
          if (message.params.update.sessionUpdate === "agent_message_chunk")
            observed.answer += message.params.update.content?.text ?? "";
          return;
        }
        if (message.id === undefined) return;
        let result;
        if (message.method === "mcp/connect") {
          observed.connects.push(message.params.serverId);
          result = { connectionId: "policy-app-connection" };
        } else if (message.method === "mcp/disconnect") result = {};
        else if (message.method === "mcp/message") {
          switch (message.params.method) {
            case "initialize":
              result = {
                protocolVersion: message.params.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "app", version: "1" },
              };
              break;
            case "ping":
              result = {};
              break;
            case "tools/list":
              observed.listCalls++;
              result = {
                tools: tools
                  .map((tool) =>
                    tool.name === "highlight"
                      ? {
                          ...tool,
                          inputSchema: {
                            type: "object",
                            properties: { changed: { type: "string" } },
                          },
                        }
                      : tool,
                  )
                  .concat([
                    {
                      name: "unapproved_policy_tool",
                      description: "Not approved",
                      inputSchema: { type: "object" },
                    },
                  ]),
              };
              break;
            case "tools/call":
              observed.toolCalls.push(message.params.params.name);
              result = {
                content: [{ type: "text", text: "unexpected policy call" }],
              };
              break;
            default:
              send({
                id: message.id,
                error: { code: -32601, message: "Unsupported method" },
              });
              return;
          }
        } else if (message.method === "session/request_permission")
          result = { outcome: { outcome: "cancelled" } };
        else {
          send({
            id: message.id,
            error: { code: -32601, message: "Denied host authority" },
          });
          return;
        }
        send({ id: message.id, result });
      };
      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new Error("policy socket failed"));
      });
      try {
        const initialized = await request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
        });
        if (initialized.error)
          throw new Error(JSON.stringify(initialized.error));
        const created = await request("session/new", {
          cwd: "/unapproved-workspace",
          mcpServers: [
            {
              type: "http",
              name: "foreign",
              url: "http://unapproved.invalid/mcp",
              headers: [],
            },
            { type: "acp", name: "app", serverId: "policy-app" },
          ],
        });
        if (created.error) throw new Error(JSON.stringify(created.error));
        const sessionId = created.result.sessionId;
        for (const method of [
          "session/set_mode",
          "session/set_config_option",
        ]) {
          observed.denied[method] = (
            await request(method, {
              sessionId,
              modeId: "agent-full-access",
              configId: "unsafe",
              value: "unsafe",
            })
          ).error?.code;
        }
        const prompted = await request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "SPIKE-TOOLS" }],
        });
        if (prompted.error) throw new Error(JSON.stringify(prompted.error));
        return { ...observed, status: `done:${prompted.result.stopReason}` };
      } finally {
        socket.close();
      }
    }, definitions),
  );
  // A fresh client loading the same owned session terminates the previous
  // attachment, through two real adapters and the real resume transport.
  Object.assign(
    report,
    await page.evaluate(async () => {
      const target = new URLSearchParams(location.search).get("gateway");
      async function connect() {
        const socket = new WebSocket(target, [
          "agent-connect.resume.v1",
          "bearer.spike-dev-token",
        ]);
        let serial = 0,
          outgoing = 0;
        const waiting = new Map();
        const closed = new Promise((resolve) => {
          socket.onclose = ({ code }) => resolve(code);
        });
        const send = (value) => socket.send(JSON.stringify(value));
        let attach;
        const attached = new Promise((resolve, reject) => {
          attach = resolve;
          socket.onerror = () => reject(new Error("two-client socket failed"));
        });
        socket.onopen = () => send({ t: "attach" });
        socket.onmessage = ({ data }) => {
          const frame = JSON.parse(data);
          if (frame.t === "attached") {
            attach();
            return;
          }
          if (frame.t !== "m") return;
          send({ t: "a", s: frame.s });
          const message = frame.m;
          if (!message.method) {
            waiting.get(message.id)?.(message);
            waiting.delete(message.id);
          }
        };
        const request = (method, params) =>
          new Promise((resolve, reject) => {
            const id = ++serial;
            const timer = setTimeout(() => {
              waiting.delete(id);
              reject(new Error(`two-client RPC timed out: ${method}`));
            }, 60000);
            waiting.set(id, (value) => {
              clearTimeout(timer);
              if (value.error) reject(new Error(JSON.stringify(value.error)));
              else resolve(value.result);
            });
            send({
              t: "m",
              s: ++outgoing,
              m: { jsonrpc: "2.0", id, method, params },
            });
          });
        await Promise.race([
          attached,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("two-client attachment timed out")),
              30000,
            ),
          ),
        ]);
        return { socket, request, closed };
      }
      let first, second;
      try {
        first = await connect();
        await first.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
        });
        const { sessionId } = await first.request("session/new", {
          cwd: "/unapproved-workspace",
          mcpServers: [],
        });
        await first.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "Plain policy ownership test" }],
        });
        second = await connect();
        await second.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
        });
        await second.request("session/load", {
          sessionId,
          cwd: "/unapproved-workspace",
          mcpServers: [],
        });
        const evictedCode = await Promise.race([
          first.closed,
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error("old client did not receive terminal eviction"),
                ),
              10000,
            ),
          ),
        ]);
        const continued = await second.request("session/prompt", {
          sessionId,
          prompt: [
            { type: "text", text: "Continue from the second policy client" },
          ],
        });
        return { evictedCode, secondClientStopReason: continued.stopReason };
      } finally {
        first?.socket.close();
        second?.socket.close();
      }
    }),
  );
} catch (error) {
  report.error = String(error?.message ?? error).split("\n")[0];
} finally {
  await browser.close();
}
console.log(JSON.stringify(report));
