import {
  beginAgentAuthorization,
  AgentConnectError,
  completeAgentAuthorization,
  connectAgent,
  parseAuthorizationTransaction,
  revokeAgentAuthorization,
  serializeAuthorizationTransaction,
  type AgentConnection,
  type AgentTaskEvent,
  type RuntimeCard,
} from "@agent-connect/web";
import {
  createDemoTools,
  DEFAULT_PROMPTS,
  type DemoScenario,
} from "./demo-tools.js";
import { mountDemoLayout } from "./layout.js";

mountDemoLayout();

const connectForm = requireElement<HTMLFormElement>("connect-form");
const taskForm = requireElement<HTMLFormElement>("task-form");
const runtimeCardInput = requireElement<HTMLTextAreaElement>("runtime-card");
const promptInput = requireElement<HTMLTextAreaElement>("prompt");
const connectButton = requireElement<HTMLButtonElement>("connect");
const runButton = requireElement<HTMLButtonElement>("run");
const disconnectButton = requireElement<HTMLButtonElement>("disconnect");
const status = requireElement<HTMLOutputElement>("status");
const eventLog = requireElement<HTMLPreElement>("events");
const connectionState = requireElement<HTMLElement>("connection-state");
const traceSummary = requireElement<HTMLSpanElement>("trace-summary");
const runtimeSummary = requireElement<HTMLDivElement>("runtime-summary");
const runtimeProfile = requireElement<HTMLElement>("runtime-profile");
const runtimeEndpoint = requireElement<HTMLElement>("runtime-endpoint");
const connectButtonLabel = connectButton.querySelector<HTMLElement>(
  ".connect-button-label",
);
const runButtonLabel = runButton.querySelector<HTMLElement>(".button-label");

const flowStages = {
  app: requireElement<HTMLLIElement>("flow-app"),
  connector: requireElement<HTMLLIElement>("flow-connector"),
  agent: requireElement<HTMLLIElement>("flow-agent"),
  tool: requireElement<HTMLLIElement>("flow-tool"),
  result: requireElement<HTMLLIElement>("flow-result"),
} as const;

type FlowStage = keyof typeof flowStages;
type FlowState = "idle" | "ready" | "active" | "complete" | "error";

const STORED_CARD = "agent-connect.runtime-card";
const STORED_GRANT = "agent-connect.grant";
const STORED_TRANSACTION = "agent-connect.authorization-transaction";
const tools = createDemoTools();

let selectedScenario: DemoScenario = "project-board";
let connection: AgentConnection | undefined;
let taskRunning = false;

runtimeCardInput.value = localStorage.getItem(STORED_CARD) ?? "";
selectScenario(selectedScenario);
syncAuthorizationControls();
updateRuntimeSummary();

connectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void connectRuntime();
});

taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runTask();
});

disconnectButton.addEventListener("click", () => void disconnect());
runtimeCardInput.addEventListener("input", updateRuntimeSummary);

const scenarioTabs = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-scenario-tab]"),
];

for (const tab of scenarioTabs) {
  const scenario = tab.dataset["scenarioTab"];
  if (isDemoScenario(scenario)) {
    tab.id = `scenario-tab-${scenario}`;
    tab.setAttribute("aria-controls", `scenario-${scenario}`);
    const panel = requireElement(`scenario-${scenario}`);
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
  }
  tab.addEventListener("click", () => {
    const nextScenario = tab.dataset["scenarioTab"];
    if (isDemoScenario(nextScenario) && !taskRunning)
      selectScenario(nextScenario);
  });
  tab.addEventListener("keydown", (event) => moveScenarioFocus(event, tab));
}

for (const copyButton of document.querySelectorAll<HTMLButtonElement>(
  "[data-copy-target]",
)) {
  copyButton.addEventListener("click", () => void copySnippet(copyButton));
}

void resumeAuthorization();

async function connectRuntime(): Promise<void> {
  setConnectBusy(true);
  resetTrace();
  setFlowStage("connector", "active");
  status.textContent = "Checking the connector and application grant…";
  connectionState.textContent = "Connecting";
  document.body.dataset["demo"] = "running";

  try {
    const runtimeCard = parseRuntimeCard(runtimeCardInput.value);
    localStorage.setItem(STORED_CARD, JSON.stringify(runtimeCard));
    showRuntimeSummary(runtimeCard);
    const grant = sessionStorage.getItem(STORED_GRANT);
    if (!grant) {
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
      status.textContent = "Opening the connector for approval…";
      connectionState.textContent = "Approval required";
      location.assign(authorization.authorizeUrl);
      return;
    }
    await establishConnection(runtimeCard, grant);
  } catch (error) {
    handleConnectionError(error);
  } finally {
    setConnectBusy(false);
  }
}

async function establishConnection(
  runtimeCard: RuntimeCard,
  accessToken: string,
): Promise<void> {
  connection = await connectAgent({
    baseUrl: runtimeCard.endpoint,
    appId: "agent-connect-demo",
    tools,
    accessToken,
  });
  setFlowStage("connector", "complete");
  connectionState.textContent = runtimeLabel(runtimeCard);
  status.textContent = "Runtime connected. Choose a feature and run a task.";
  traceSummary.textContent = "Connector verified and session ready";
  document.body.dataset["demo"] = "connected";
  syncAuthorizationControls();
}

async function runTask(): Promise<void> {
  if (!connection) {
    status.textContent = "Connect a runtime before running a task.";
    connectButton.focus();
    return;
  }
  taskRunning = true;
  setRunBusy(true);
  eventLog.textContent = "";
  resetTaskTrace();
  setFlowStage("agent", "active");
  traceSummary.textContent =
    "The runtime received the task and nine-tool snapshot";
  status.textContent = "The connected runtime is working…";
  document.body.dataset["demo"] = "running";
  const surface = requireElement(`scenario-${selectedScenario}`);
  delete surface.dataset["changed"];

  try {
    const prompt = `[Agent Connect demo scenario: ${selectedScenario}]\n${promptInput.value}`;
    for await (const taskEvent of connection.session.streamTask(prompt)) {
      appendEvent(taskEvent);
      if (taskEvent.type === "task.completed") {
        if (surface.dataset["changed"] !== "true") {
          throw new Error(
            "The runtime finished without changing the selected app",
          );
        }
        status.textContent = "The app was updated through its own tools.";
        traceSummary.textContent =
          "Tool results returned and the task completed";
        document.body.dataset["demo"] = "passed";
      } else if (taskEvent.type === "task.failed") {
        throw new Error(taskEvent.error.message);
      }
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Task failed";
    setCurrentFlowError();
    document.body.dataset["demo"] = "failed";
  } finally {
    taskRunning = false;
    setRunBusy(false);
  }
}

async function resumeAuthorization(): Promise<void> {
  const callback = new URL(location.href);
  if (!callback.searchParams.has("code") && !callback.searchParams.has("error"))
    return;
  const serialized = sessionStorage.getItem(STORED_TRANSACTION);
  const serializedCard = localStorage.getItem(STORED_CARD);
  if (!serialized || !serializedCard) {
    status.textContent = "The saved authorization transaction is missing.";
    return;
  }
  setConnectBusy(true);
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
    sessionStorage.removeItem(STORED_TRANSACTION);
    history.replaceState({}, "", callback.pathname);
    await establishConnection(runtimeCard, grant.accessToken);
  } catch (error) {
    handleConnectionError(error);
  } finally {
    setConnectBusy(false);
  }
}

function handleConnectionError(error: unknown): void {
  if (
    error instanceof AgentConnectError &&
    error.code === "invalid_app_grant"
  ) {
    clearLocalAuthorization();
    status.textContent = "Authorization expired or was revoked. Connect again.";
    connectionState.textContent = "Authorization expired";
    document.body.dataset["demo"] = "reauthorize";
  } else {
    status.textContent =
      error instanceof Error ? error.message : "Connection failed";
    connectionState.textContent = "Connection failed";
    document.body.dataset["demo"] = "failed";
  }
  setFlowStage("connector", "error");
  setCurrentFlowError();
}

function clearLocalAuthorization(): void {
  sessionStorage.removeItem(STORED_GRANT);
  sessionStorage.removeItem(STORED_TRANSACTION);
  connection = undefined;
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
    status.textContent = "Disconnected. Connect again whenever you are ready.";
    connectionState.textContent = "Not connected";
    resetTrace();
    document.body.dataset["demo"] = "disconnected";
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Could not disconnect";
    connectionState.textContent = "Disconnect failed";
    document.body.dataset["demo"] = "failed";
  } finally {
    disconnectButton.disabled = false;
  }
}

function selectScenario(scenario: DemoScenario): void {
  selectedScenario = scenario;
  for (const tab of document.querySelectorAll<HTMLButtonElement>(
    "[data-scenario-tab]",
  )) {
    const selected = tab.dataset["scenarioTab"] === scenario;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of document.querySelectorAll<HTMLElement>(
    "[data-scenario-panel]",
  )) {
    panel.hidden = panel.dataset["scenarioPanel"] !== scenario;
  }
  promptInput.value = DEFAULT_PROMPTS[scenario];
}

function appendEvent(event: AgentTaskEvent): void {
  eventLog.textContent += `${JSON.stringify(event)}\n`;
  switch (event.type) {
    case "task.started":
      setFlowStage("agent", "active");
      traceSummary.textContent = "The connected runtime is working";
      break;
    case "tool.requested":
      setFlowStage("agent", "complete");
      setFlowStage("tool", "active");
      traceSummary.textContent = `Runtime requested ${event.name}`;
      break;
    case "tool.completed":
      setFlowStage("tool", event.isError ? "error" : "complete");
      if (!event.isError) setFlowStage("result", "complete");
      traceSummary.textContent = event.isError
        ? "The application tool returned an error"
        : "The application returned the correlated tool result";
      break;
    case "task.completed":
      setFlowStage("agent", "complete");
      break;
    case "task.failed":
      setCurrentFlowError();
      break;
  }
}

function resetTrace(): void {
  for (const [stage, element] of Object.entries(flowStages)) {
    element.dataset["state"] = stage === "app" ? "ready" : "idle";
  }
  traceSummary.textContent = "Waiting for a connection";
}

function resetTaskTrace(): void {
  setFlowStage("app", "complete");
  setFlowStage("connector", "complete");
  setFlowStage("agent", "active");
  setFlowStage("tool", "idle");
  setFlowStage("result", "idle");
}

function setFlowStage(stage: FlowStage, state: FlowState): void {
  flowStages[stage].dataset["state"] = state;
}

function setCurrentFlowError(): void {
  const active = Object.values(flowStages).find(
    (element) => element.dataset["state"] === "active",
  );
  if (active) active.dataset["state"] = "error";
  traceSummary.textContent = "The flow stopped at the highlighted boundary";
}

function syncAuthorizationControls(): void {
  const authorized = sessionStorage.getItem(STORED_GRANT) !== null;
  disconnectButton.hidden = !authorized;
  runButton.disabled = !connection;
  connectButton.disabled = connection !== undefined;
  if (connectButtonLabel)
    connectButtonLabel.textContent = connection
      ? "Runtime connected"
      : "Connect runtime";
}

function setConnectBusy(busy: boolean): void {
  connectButton.disabled = busy || connection !== undefined;
  if (connectButtonLabel)
    connectButtonLabel.textContent = busy
      ? "Connecting…"
      : connection
        ? "Runtime connected"
        : "Connect runtime";
}

function setRunBusy(busy: boolean): void {
  runButton.disabled = busy || !connection;
  for (const tab of scenarioTabs) tab.disabled = busy;
  if (runButtonLabel)
    runButtonLabel.textContent = busy ? "Running task…" : "Run task";
}

function moveScenarioFocus(
  event: KeyboardEvent,
  current: HTMLButtonElement,
): void {
  const currentIndex = scenarioTabs.indexOf(current);
  let nextIndex: number | undefined;
  if (event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % scenarioTabs.length;
  } else if (event.key === "ArrowLeft") {
    nextIndex = (currentIndex - 1 + scenarioTabs.length) % scenarioTabs.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = scenarioTabs.length - 1;
  }
  if (nextIndex === undefined) return;
  event.preventDefault();
  const next = scenarioTabs[nextIndex];
  const scenario = next?.dataset["scenarioTab"];
  if (!next || !isDemoScenario(scenario)) return;
  selectScenario(scenario);
  next.focus();
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

function updateRuntimeSummary(): void {
  if (!runtimeCardInput.value.trim()) {
    runtimeSummary.hidden = true;
    return;
  }
  try {
    showRuntimeSummary(parseRuntimeCard(runtimeCardInput.value));
  } catch {
    runtimeSummary.hidden = true;
  }
}

function showRuntimeSummary(runtimeCard: RuntimeCard): void {
  runtimeSummary.hidden = false;
  runtimeProfile.textContent = runtimeLabel(runtimeCard);
  runtimeEndpoint.textContent = runtimeCard.endpoint;
}

function runtimeLabel(runtimeCard: RuntimeCard): string {
  return runtimeCard.transportProfile === "public-demo"
    ? "Recorded Codex plan · deterministic ACP"
    : "Codex through OmniGENT";
}

async function copySnippet(button: HTMLButtonElement): Promise<void> {
  const targetId = button.dataset["copyTarget"];
  if (!targetId) return;
  const target = document.getElementById(targetId);
  if (!target) return;
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(target.textContent ?? "");
    button.textContent = "Copied";
  } catch {
    button.textContent = "Select text";
  }
  window.setTimeout(() => (button.textContent = original), 1600);
}

function isDemoScenario(value: string | undefined): value is DemoScenario {
  return (
    value === "project-board" ||
    value === "document-review" ||
    value === "product-research"
  );
}

function requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
