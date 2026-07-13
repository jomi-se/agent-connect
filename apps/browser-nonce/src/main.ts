import {
  connectOmnigent,
  defineTool,
  type AgentTaskEvent,
} from "@agent-connect/web";

const form = requireElement<HTMLFormElement>("task-form");
const sessionInput = requireElement<HTMLInputElement>("session-id");
const promptInput = requireElement<HTMLTextAreaElement>("prompt");
const runButton = requireElement<HTMLButtonElement>("run");
const result = requireElement<HTMLOutputElement>("result");
const eventLog = requireElement<HTMLPreElement>("events");

sessionInput.value = new URL(location.href).searchParams.get("session") ?? "";

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void run();
});

async function run(): Promise<void> {
  runButton.disabled = true;
  eventLog.textContent = "";
  result.textContent = "Running…";
  const nonce = `browser-${crypto.randomUUID()}`;
  let calls = 0;
  const session = connectOmnigent({
    baseUrl: "/omnigent",
    sessionId: sessionInput.value,
    tools: [
      defineTool({
        name: "get_browser_nonce",
        description:
          "Return a fresh unpredictable value owned by this web page.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: () => {
          calls += 1;
          if (calls > 1) throw new Error("Nonce tool called more than once");
          return nonce;
        },
      }),
    ],
  });

  try {
    for await (const taskEvent of session.streamTask(promptInput.value)) {
      appendEvent(taskEvent);
      if (taskEvent.type === "task.completed") {
        if (calls !== 1 || !taskEvent.text.includes(nonce)) {
          throw new Error(
            "The browser nonce did not complete the same agent turn",
          );
        }
        result.textContent = taskEvent.text;
        document.body.dataset["spike"] = "passed";
      } else if (taskEvent.type === "task.failed") {
        throw new Error(taskEvent.error.message);
      }
    }
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : "Task failed";
    document.body.dataset["spike"] = "failed";
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
