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
  SCENARIO_TOOL_NAMES,
  type DemoScenario,
} from "./demo-tools.js";
import { mountDemoLayout } from "./layout.js";

mountDemoLayout();

type GatewayTerminalStep =
  | { kind: "command"; text: string }
  | { kind: "output"; text: string; tone?: "success" | "muted" };

// Keep the installation story in one editable sequence while packaging evolves.
const GATEWAY_TERMINAL_STEPS: readonly GatewayTerminalStep[] = [
  {
    kind: "output",
    text: "# after configuring the runtime adapter and transport",
    tone: "muted",
  },
  { kind: "command", text: "npm install" },
  { kind: "output", text: "workspace dependencies installed", tone: "success" },
  {
    kind: "command",
    text: "npm run build --workspace @agent-connect/gateway",
  },
  { kind: "output", text: "gateway build complete", tone: "success" },
  {
    kind: "command",
    text: "npm run start --workspace @agent-connect/gateway",
  },
  {
    kind: "output",
    text: "listening on http://127.0.0.1:8787",
    tone: "success",
  },
  {
    kind: "output",
    text: "runtime card ready · waiting for app authorization",
  },
];

mountGatewayTerminals();
highlightTypescriptSnippets();

const connectForm = requireElement<HTMLFormElement>("connect-form");
const taskForm = requireElement<HTMLFormElement>("task-form");
const runtimeCardInput = requireElement<HTMLTextAreaElement>("runtime-card");
const promptInput = requireElement<HTMLTextAreaElement>("prompt");
const connectButton = requireElement<HTMLButtonElement>("connect");
const runButton = requireElement<HTMLButtonElement>("run");
const disconnectButton = requireElement<HTMLButtonElement>("disconnect");
const status = requireElement<HTMLOutputElement>("status");
const eventLog = requireElement<HTMLPreElement>("events");
const activityFeed = requireElement<HTMLOListElement>("activity-feed");
const connectionState = requireElement<HTMLElement>("connection-state");
const traceSummary = requireElement<HTMLSpanElement>("trace-summary");
const runtimeSummary = requireElement<HTMLDivElement>("runtime-summary");
const runtimeProfile = requireElement<HTMLElement>("runtime-profile");
const runtimeEndpoint = requireElement<HTMLElement>("runtime-endpoint");
const connectButtonLabel = connectButton.querySelector<HTMLElement>(
  ".connect-button-label",
);
const runButtonLabel = runButton.querySelector<HTMLElement>(".button-label");
const showToolsButton = requireElement<HTMLButtonElement>("show-tools");
const toolDialog = requireElement<HTMLDialogElement>("tool-dialog");
const toolDialogTitle = requireElement<HTMLElement>("tool-dialog-title");
const toolList = requireElement<HTMLElement>("tool-list");

const STORED_CARD = "agent-connect.runtime-card";
const STORED_GRANT = "agent-connect.grant";
const STORED_TRANSACTION = "agent-connect.authorization-transaction";
const tools = createDemoTools();

let selectedScenario: DemoScenario = "project-board";
let connection: AgentConnection | undefined;
let taskRunning = false;
let activeConnectionActivity: HTMLLIElement | undefined;
const activeToolActivities = new Map<string, HTMLLIElement>();

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
showToolsButton.addEventListener("click", showScenarioTools);
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
  resetActivity();
  activeConnectionActivity = addActivity(
    "connector",
    "Checking connector access",
    "Runtime card and application grant",
    "active",
  );
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
      updateActivity(
        activeConnectionActivity,
        "Application approval required",
        "Opening the connector-owned consent page",
        "active",
      );
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
  if (activeConnectionActivity) {
    updateActivity(
      activeConnectionActivity,
      "Runtime connected",
      runtimeLabel(runtimeCard),
      "complete",
    );
  } else {
    addActivity(
      "connector",
      "Runtime connected",
      runtimeLabel(runtimeCard),
      "complete",
    );
  }
  activeConnectionActivity = undefined;
  connectionState.textContent = runtimeLabel(runtimeCard);
  status.textContent = "Runtime connected. Choose a feature and run a task.";
  traceSummary.textContent = "Runtime connected";
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
  activeToolActivities.clear();
  traceSummary.textContent = "Sending task";
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
        traceSummary.textContent = "Task completed";
        document.body.dataset["demo"] = "passed";
      } else if (taskEvent.type === "task.failed") {
        throw new Error(taskEvent.error.message);
      }
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Task failed";
    setCurrentActivityError(
      error instanceof Error ? error.message : "Task failed",
    );
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
  if (activeConnectionActivity) {
    updateActivity(
      activeConnectionActivity,
      "Connection failed",
      error instanceof Error ? error.message : "Connection failed",
      "error",
    );
    activeConnectionActivity = undefined;
  } else {
    setCurrentActivityError(
      error instanceof Error ? error.message : "Connection failed",
    );
  }
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
    addActivity(
      "connector",
      "Access revoked",
      "This browser app is disconnected",
      "complete",
    );
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
      addActivity(
        "runtime",
        "Task started",
        scenarioTitle(selectedScenario),
        "active",
      );
      traceSummary.textContent = "Runtime is working";
      break;
    case "tool.requested":
      activeToolActivities.set(
        event.actionId,
        addActivity(
          "tool",
          event.name,
          "Tool call requested by the runtime",
          "active",
        ),
      );
      traceSummary.textContent = `Runtime requested ${event.name}`;
      break;
    case "tool.completed": {
      const toolActivity = activeToolActivities.get(event.actionId);
      if (toolActivity) {
        updateActivity(
          toolActivity,
          event.name,
          event.isError ? "Application tool failed" : "Executed by the web app",
          event.isError ? "error" : "complete",
        );
        activeToolActivities.delete(event.actionId);
      }
      addActivity(
        "result",
        `${event.name} result`,
        event.isError
          ? "Error returned to the runtime"
          : "Returned to the runtime",
        event.isError ? "error" : "complete",
      );
      traceSummary.textContent = event.isError
        ? "The application tool returned an error"
        : "The application returned the correlated tool result";
      break;
    }
    case "task.completed":
      completeLatestRuntimeActivity();
      addActivity(
        "runtime",
        "Task completed",
        scenarioTitle(selectedScenario),
        "complete",
      );
      break;
    case "task.failed":
      setCurrentActivityError(event.error.message);
      break;
  }
}

function resetActivity(): void {
  activityFeed.replaceChildren();
  activeToolActivities.clear();
  activeConnectionActivity = undefined;
  traceSummary.textContent = "No events yet";
}

type ActivityKind = "connector" | "runtime" | "tool" | "result";
type ActivityState = "active" | "complete" | "error";

function addActivity(
  kind: ActivityKind,
  title: string,
  detail: string,
  state: ActivityState,
): HTMLLIElement {
  const item = document.createElement("li");
  item.dataset["kind"] = kind;
  item.dataset["state"] = state;
  const marker = document.createElement("span");
  marker.className = "activity-marker";
  marker.setAttribute("aria-hidden", "true");
  const copy = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const description = document.createElement("span");
  description.textContent = detail;
  copy.append(heading, description);
  item.append(marker, copy);
  activityFeed.append(item);
  activityFeed.scrollTo({
    top: activityFeed.scrollHeight,
    behavior: reducedMotion() ? "auto" : "smooth",
  });
  return item;
}

function updateActivity(
  item: HTMLLIElement,
  title: string,
  detail: string,
  state: ActivityState,
): void {
  item.dataset["state"] = state;
  const heading = item.querySelector("strong");
  const description = item.querySelector("div > span");
  if (heading) heading.textContent = title;
  if (description) description.textContent = detail;
}

function completeLatestRuntimeActivity(): void {
  const active = [...activityFeed.querySelectorAll<HTMLLIElement>("li")]
    .reverse()
    .find(
      (item) =>
        item.dataset["kind"] === "runtime" &&
        item.dataset["state"] === "active",
    );
  if (active) active.dataset["state"] = "complete";
}

function setCurrentActivityError(message: string): void {
  const active = [...activityFeed.querySelectorAll<HTMLLIElement>("li")]
    .reverse()
    .find((item) => item.dataset["state"] === "active");
  if (active) {
    const title = active.querySelector("strong")?.textContent ?? "Request";
    updateActivity(active, title, message, "error");
  } else {
    addActivity("runtime", "Request failed", message, "error");
  }
  traceSummary.textContent = "Request failed";
}

function showScenarioTools(): void {
  toolDialogTitle.textContent = `${scenarioTitle(selectedScenario)} tools`;
  toolList.replaceChildren();
  for (const name of SCENARIO_TOOL_NAMES[selectedScenario]) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) continue;
    const contract = document.createElement("article");
    contract.className = "tool-contract";
    const heading = document.createElement("div");
    heading.className = "tool-contract-heading";
    const title = document.createElement("code");
    title.textContent = tool.name;
    const ownership = document.createElement("span");
    ownership.textContent = "Runs in this app";
    heading.append(title, ownership);
    const description = document.createElement("p");
    description.textContent = tool.description;
    const inputHeading = document.createElement("h3");
    inputHeading.textContent = "Inputs";
    const fields = renderSchemaFields(tool.inputSchema as DisplaySchema);
    contract.append(heading, description, inputHeading, fields);
    toolList.append(contract);
  }
  toolDialog.showModal();
}

type DisplaySchema = {
  type?: string;
  enum?: readonly unknown[];
  properties?: Readonly<Record<string, DisplaySchema>>;
  required?: readonly string[];
  items?: DisplaySchema;
};

function renderSchemaFields(schema: DisplaySchema): HTMLUListElement {
  const list = document.createElement("ul");
  list.className = "tool-field-list";
  const required = new Set(schema.required ?? []);
  for (const [name, fieldSchema] of Object.entries(schema.properties ?? {})) {
    list.append(renderSchemaField(name, fieldSchema, required.has(name)));
  }
  return list;
}

function renderSchemaField(
  name: string,
  schema: DisplaySchema,
  required: boolean,
): HTMLLIElement {
  const field = document.createElement("li");
  field.className = "tool-field";
  const heading = document.createElement("div");
  heading.className = "tool-field-heading";
  const fieldName = document.createElement("code");
  fieldName.textContent = name;
  const type = document.createElement("span");
  type.className = "tool-field-type";
  type.textContent = schemaTypeLabel(schema);
  const requirement = document.createElement("span");
  requirement.className = "tool-field-requirement";
  requirement.dataset["required"] = String(required);
  requirement.textContent = required ? "Required" : "Optional";
  heading.append(fieldName, type, requirement);
  field.append(heading);

  if (schema.enum) field.append(renderEnumValues(schema.enum));
  if (schema.type === "array" && schema.items?.type === "object") {
    const nested = renderSchemaFields(schema.items);
    nested.classList.add("tool-nested-fields");
    field.append(nested);
  }
  return field;
}

function renderEnumValues(values: readonly unknown[]): HTMLDivElement {
  const choices = document.createElement("div");
  choices.className = "tool-enum-values";
  choices.setAttribute("aria-label", "Allowed values");
  for (const value of values) {
    const choice = document.createElement("code");
    choice.textContent = String(value);
    choices.append(choice);
  }
  return choices;
}

function schemaTypeLabel(schema: DisplaySchema): string {
  if (schema.enum) return "choice";
  if (schema.type === "array") {
    if (schema.items?.type === "object") return "list of objects";
    if (schema.items?.type === "string") return "list of text";
    return "list";
  }
  if (schema.type === "string") return "text";
  return schema.type ?? "value";
}

function scenarioTitle(scenario: DemoScenario): string {
  if (scenario === "project-board") return "Project board";
  if (scenario === "document-review") return "Document review";
  return "Product research";
}

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const terminalRuns = new WeakMap<HTMLElement, number>();

function mountGatewayTerminals(): void {
  for (const host of document.querySelectorAll<HTMLElement>(
    "[data-gateway-terminal]",
  )) {
    const terminal = document.createElement("div");
    terminal.className = "gateway-terminal";
    terminal.setAttribute(
      "aria-label",
      "Animated terminal showing the current Agent Connect gateway startup",
    );

    const toolbar = document.createElement("div");
    toolbar.className = "terminal-toolbar";
    const controls = document.createElement("span");
    controls.className = "terminal-window-controls";
    controls.setAttribute("aria-hidden", "true");
    controls.append(
      document.createElement("i"),
      document.createElement("i"),
      document.createElement("i"),
    );
    const title = document.createElement("span");
    title.className = "terminal-title";
    title.textContent = "agent-connect — zsh";
    const replay = document.createElement("button");
    replay.type = "button";
    replay.className = "terminal-replay";
    replay.textContent = "Replay";
    toolbar.append(controls, title, replay);

    const lines = document.createElement("ol");
    lines.className = "terminal-lines";
    for (const step of GATEWAY_TERMINAL_STEPS) {
      const line = document.createElement("li");
      line.className = `terminal-line terminal-line-${step.kind}`;
      line.dataset["state"] = "pending";
      if (step.kind === "command") {
        const prompt = document.createElement("span");
        prompt.className = "terminal-prompt";
        prompt.textContent = "$";
        prompt.setAttribute("aria-hidden", "true");
        const command = document.createElement("span");
        command.className = "terminal-command-copy";
        const ghost = document.createElement("span");
        ghost.className = "terminal-command-ghost";
        ghost.textContent = step.text;
        const typed = document.createElement("span");
        typed.className = "terminal-command-typed";
        typed.setAttribute("aria-hidden", "true");
        command.append(ghost, typed);
        line.append(prompt, command);
      } else {
        line.textContent = step.text;
        if (step.tone) line.dataset["tone"] = step.tone;
      }
      lines.append(line);
    }
    terminal.append(toolbar, lines);
    host.append(terminal);

    replay.addEventListener("click", () => void playGatewayTerminal(terminal));
    if (reducedMotion() || !("IntersectionObserver" in window)) {
      completeGatewayTerminal(terminal);
      continue;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void playGatewayTerminal(terminal);
      },
      { threshold: 0.45 },
    );
    observer.observe(terminal);
  }
}

async function playGatewayTerminal(terminal: HTMLElement): Promise<void> {
  const run = (terminalRuns.get(terminal) ?? 0) + 1;
  terminalRuns.set(terminal, run);
  const lines = [...terminal.querySelectorAll<HTMLLIElement>(".terminal-line")];
  for (const line of lines) {
    line.dataset["state"] = "pending";
    const typed = line.querySelector<HTMLElement>(".terminal-command-typed");
    if (typed) typed.textContent = "";
  }

  await terminalDelay(180);
  for (let index = 0; index < GATEWAY_TERMINAL_STEPS.length; index += 1) {
    if (terminalRuns.get(terminal) !== run) return;
    const step = GATEWAY_TERMINAL_STEPS[index];
    const line = lines[index];
    if (!step || !line) continue;
    line.dataset["state"] = "current";
    if (step.kind === "command") {
      const typed = line.querySelector<HTMLElement>(".terminal-command-typed");
      for (let character = 1; character <= step.text.length; character += 1) {
        if (terminalRuns.get(terminal) !== run) return;
        if (typed) typed.textContent = step.text.slice(0, character);
        await terminalDelay(12);
      }
      await terminalDelay(180);
    } else {
      await terminalDelay(280);
    }
    line.dataset["state"] = "complete";
    await terminalDelay(90);
  }
}

function completeGatewayTerminal(terminal: HTMLElement): void {
  for (const [index, line] of [
    ...terminal.querySelectorAll<HTMLLIElement>(".terminal-line"),
  ].entries()) {
    line.dataset["state"] = "complete";
    const step = GATEWAY_TERMINAL_STEPS[index];
    const typed = line.querySelector<HTMLElement>(".terminal-command-typed");
    if (typed && step?.kind === "command") typed.textContent = step.text;
  }
}

function terminalDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function highlightTypescriptSnippets(): void {
  for (const code of document.querySelectorAll<HTMLElement>(
    'code[data-language="typescript"]',
  )) {
    code.innerHTML = highlightTypescript(code.textContent ?? "");
  }
}

function highlightTypescript(source: string): string {
  const tokenPattern =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:const|let|var|await|async|for|of|return|if|else|throw|new|true|false|null|undefined)\b)|(\b[A-Za-z_$][\w$]*(?=\s*\())|(\b\d+(?:\.\d+)?\b)/g;
  let highlighted = "";
  let cursor = 0;
  for (const match of source.matchAll(tokenPattern)) {
    const index = match.index;
    highlighted += escapeCode(source.slice(cursor, index));
    const className = match[1]
      ? "syntax-comment"
      : match[2]
        ? "syntax-string"
        : match[3]
          ? "syntax-keyword"
          : match[4]
            ? "syntax-function"
            : "syntax-number";
    highlighted += `<span class="${className}">${escapeCode(match[0])}</span>`;
    cursor = index + match[0].length;
  }
  return highlighted + escapeCode(source.slice(cursor));
}

function escapeCode(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
