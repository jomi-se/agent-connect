import {
  beginAgentAuthorization,
  AgentConnectError,
  completeAgentAuthorization,
  connectAgent,
  defineTool,
  parseAuthorizationTransaction,
  revokeAgentAuthorization,
  serializeAuthorizationTransaction,
  type AgentTaskEvent,
  type ApplicationTool,
  type RuntimeCard,
} from "@agent-connect/web";

const form = requireElement<HTMLFormElement>("task-form");
const runtimeCardInput = requireElement<HTMLTextAreaElement>("runtime-card");
const promptInput = requireElement<HTMLTextAreaElement>("prompt");
const runButton = requireElement<HTMLButtonElement>("run");
const disconnectButton = requireElement<HTMLButtonElement>("disconnect");
const canvasMessage = requireElement<HTMLParagraphElement>("canvas-message");
const status = requireElement<HTMLOutputElement>("status");
const eventLog = requireElement<HTMLPreElement>("events");

const STORED_CARD = "agent-connect.runtime-card";
const STORED_GRANT = "agent-connect.grant";
const STORED_TRANSACTION = "agent-connect.authorization-transaction";
const STORED_PROMPT = "agent-connect.pending-prompt";

runtimeCardInput.value = localStorage.getItem(STORED_CARD) ?? "";
syncAuthorizationControls();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void run();
});

disconnectButton.addEventListener("click", () => {
  void disconnect();
});

void resumeAuthorization();

async function run(): Promise<void> {
  runButton.disabled = true;
  eventLog.textContent = "";
  status.textContent = "Asking your agent…";
  document.body.dataset["demo"] = "running";
  const runtimeCard = parseRuntimeCard(runtimeCardInput.value);
  localStorage.setItem(STORED_CARD, JSON.stringify(runtimeCard));

  let writes = 0;
  const tools: readonly ApplicationTool[] = [
    defineTool({
      name: "set_page_message",
      description: "Replace the large visible message on the user's web page.",
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
  ];

  try {
    const storedToken = sessionStorage.getItem(STORED_GRANT);
    if (!storedToken) {
      sessionStorage.setItem(STORED_PROMPT, promptInput.value);
      const authorization = await beginAgentAuthorization({
        runtimeCard,
        appId: "agent-connect-demo",
        redirectUri: callbackUri(),
        tools,
      });
      sessionStorage.setItem(
        STORED_TRANSACTION,
        serializeAuthorizationTransaction(authorization.transaction),
      );
      status.textContent = "Opening your connector for approval…";
      location.assign(authorization.authorizeUrl);
      return;
    }
    syncAuthorizationControls();
    const connection = await connectAgent({
      baseUrl: runtimeCard.endpoint,
      appId: "agent-connect-demo",
      tools,
      accessToken: storedToken,
    });
    // Keep the durable authorization grant. The connection token is a
    // short-lived session capability and must not replace the credential that
    // can mint a fresh capability after a restart or expiry.
    for await (const taskEvent of connection.session.streamTask(
      promptInput.value,
    )) {
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
    if (
      error instanceof AgentConnectError &&
      error.code === "invalid_app_grant"
    ) {
      clearLocalAuthorization();
      status.textContent =
        "Authorization was revoked or expired. Run again to reconnect.";
      document.body.dataset["demo"] = "reauthorize";
    } else {
      status.textContent =
        error instanceof Error ? error.message : "Task failed";
      document.body.dataset["demo"] = "failed";
    }
  } finally {
    runButton.disabled = false;
  }
}

async function resumeAuthorization(): Promise<void> {
  const callback = new URL(location.href);
  if (
    !callback.searchParams.has("code") &&
    !callback.searchParams.has("error")
  ) {
    return;
  }
  const serialized = sessionStorage.getItem(STORED_TRANSACTION);
  const serializedCard = localStorage.getItem(STORED_CARD);
  if (!serialized || !serializedCard) {
    status.textContent = "The saved authorization transaction is missing.";
    return;
  }
  try {
    const runtimeCard = parseRuntimeCard(serializedCard);
    const grant = await completeAgentAuthorization({
      runtimeCard,
      appId: "agent-connect-demo",
      redirectUri: callbackUri(),
      transaction: parseAuthorizationTransaction(serialized),
      callbackUrl: location.href,
    });
    sessionStorage.setItem(STORED_GRANT, grant.accessToken);
    syncAuthorizationControls();
    sessionStorage.removeItem(STORED_TRANSACTION);
    const pendingPrompt = sessionStorage.getItem(STORED_PROMPT);
    sessionStorage.removeItem(STORED_PROMPT);
    history.replaceState({}, "", callback.pathname);
    status.textContent = "Authorized. Starting your task…";
    if (pendingPrompt) promptInput.value = pendingPrompt;
    await run();
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Authorization failed";
    document.body.dataset["demo"] = "failed";
  }
}

function clearLocalAuthorization(): void {
  sessionStorage.removeItem(STORED_GRANT);
  sessionStorage.removeItem(STORED_TRANSACTION);
  sessionStorage.removeItem(STORED_PROMPT);
  syncAuthorizationControls();
}

async function disconnect(): Promise<void> {
  const accessToken = sessionStorage.getItem(STORED_GRANT);
  if (!accessToken) return;
  disconnectButton.disabled = true;
  status.textContent = "Revoking this app's access…";
  try {
    const serializedCard = localStorage.getItem(STORED_CARD);
    if (!serializedCard) throw new Error("The saved runtime card is missing.");
    const runtimeCard = parseRuntimeCard(serializedCard);
    await revokeAgentAuthorization({
      baseUrl: runtimeCard.endpoint,
      appId: "agent-connect-demo",
      accessToken,
    });
    clearLocalAuthorization();
    status.textContent = "Disconnected. Run again to authorize this app.";
    document.body.dataset["demo"] = "disconnected";
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Could not disconnect";
    document.body.dataset["demo"] = "failed";
  } finally {
    disconnectButton.disabled = false;
  }
}

function syncAuthorizationControls(): void {
  disconnectButton.hidden = !sessionStorage.getItem(STORED_GRANT);
}

function callbackUri(): string {
  return `${location.origin}${location.pathname}`;
}

function parseRuntimeCard(value: string): RuntimeCard {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Paste a valid Agent Connect runtime card");
  }
  const candidate = parsed as Partial<RuntimeCard>;
  if (
    candidate.version !== 1 ||
    typeof candidate.runtimeId !== "string" ||
    typeof candidate.endpoint !== "string" ||
    typeof candidate.connectorPublicKey !== "object" ||
    candidate.connectorPublicKey === null ||
    typeof candidate.transportProfile !== "string" ||
    typeof candidate.authorizationServer !== "string"
  ) {
    throw new TypeError("Paste a valid Agent Connect runtime card");
  }
  return candidate as RuntimeCard;
}

function appendEvent(event: AgentTaskEvent): void {
  eventLog.textContent += `${JSON.stringify(event)}\n`;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
