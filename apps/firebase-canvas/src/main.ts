import {
  connectOmnigent,
  defineTool,
  type AgentTaskEvent,
} from "@agent-connect/web";

const form = requireElement<HTMLFormElement>("task-form");
const gatewayInput = requireElement<HTMLInputElement>("gateway-url");
const sessionInput = requireElement<HTMLInputElement>("session-id");
const tokenInput = requireElement<HTMLInputElement>("access-token");
const promptInput = requireElement<HTMLTextAreaElement>("prompt");
const runButton = requireElement<HTMLButtonElement>("run");
const canvasMessage = requireElement<HTMLParagraphElement>("canvas-message");
const status = requireElement<HTMLOutputElement>("status");
const eventLog = requireElement<HTMLPreElement>("events");

const params = new URL(location.href).searchParams;
gatewayInput.value =
  params.get("gateway") ??
  sessionStorage.getItem("agent-connect.gateway") ??
  "https://artifex-box.tail246db1.ts.net:8443";
sessionInput.value = params.get("session") ?? "";
tokenInput.value = sessionStorage.getItem("agent-connect.token") ?? "";

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void run();
});

async function run(): Promise<void> {
  runButton.disabled = true;
  eventLog.textContent = "";
  status.textContent = "Asking your agent…";
  document.body.dataset["demo"] = "running";
  sessionStorage.setItem("agent-connect.gateway", gatewayInput.value);
  if (tokenInput.value) {
    sessionStorage.setItem("agent-connect.token", tokenInput.value);
  } else {
    sessionStorage.removeItem("agent-connect.token");
  }

  let writes = 0;
  const headers = tokenInput.value
    ? { Authorization: `Bearer ${tokenInput.value}` }
    : {};
  const session = connectOmnigent({
    baseUrl: gatewayInput.value,
    sessionId: sessionInput.value,
    headers,
    tools: [
      defineTool({
        name: "set_page_message",
        description:
          "Replace the large visible message on the user's web page.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              minLength: 1,
              maxLength: 180,
              description: "The complete message to show on the page.",
            },
          },
          required: ["message"],
          additionalProperties: false,
        },
        execute: ({ message }) => {
          if (typeof message !== "string") {
            throw new TypeError("message must be a string");
          }
          writes += 1;
          canvasMessage.textContent = message;
          canvasMessage.dataset["agentWrites"] = String(writes);
          return {
            content: [{ type: "text", text: "The page message was updated." }],
            structuredContent: { displayed: true, message, writes },
          };
        },
      }),
    ],
  });

  try {
    for await (const taskEvent of session.streamTask(promptInput.value)) {
      appendEvent(taskEvent);
      if (taskEvent.type === "task.completed") {
        if (writes === 0) {
          throw new Error("The agent finished without writing to the page");
        }
        status.textContent = taskEvent.text || "Page updated.";
        document.body.dataset["demo"] = "passed";
      } else if (taskEvent.type === "task.failed") {
        throw new Error(taskEvent.error.message);
      }
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Task failed";
    document.body.dataset["demo"] = "failed";
  } finally {
    runButton.disabled = false;
  }
}

function appendEvent(event: AgentTaskEvent): void {
  eventLog.textContent += `${JSON.stringify(event)}\n`;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
