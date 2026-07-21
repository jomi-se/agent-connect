import {
  beginAgentAuthorization,
  AgentConnectError,
  completeAgentAuthorization,
  connectAgent,
  parseRuntimeCard,
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
    text: "# authenticated Codex + Tailscale required",
    tone: "muted",
  },
  {
    kind: "command",
    text: "curl -fsSL https://omnigent.ai/install.sh | sh -s -- --version 0.5.1",
  },
  {
    kind: "command",
    text: "git clone https://github.com/jomi-se/agent-connect.git && cd agent-connect",
  },
  { kind: "command", text: "npm install && npm run build" },
  {
    kind: "command",
    text: 'mkdir -p "$HOME/.agent-connect/codex-home" && chmod 700 "$HOME/.agent-connect/codex-home"',
  },
  {
    kind: "command",
    text: 'CODEX_HOME="$HOME/.agent-connect/codex-home" codex login',
  },
  {
    kind: "command",
    text: "cp deploy/real-gateway/.env.example deploy/real-gateway/.env && chmod 600 deploy/real-gateway/.env",
  },
  {
    kind: "output",
    text: "# set Serve URL, Tailscale login, Codex home, workspace",
    tone: "muted",
  },
  { kind: "command", text: "$EDITOR deploy/real-gateway/.env" },
  { kind: "command", text: "deploy/real-gateway/run.sh" },
  {
    kind: "output",
    text: "runtime card + enrollment passphrase ready",
    tone: "success",
  },
  {
    kind: "output",
    text: "# in another shell, publish the loopback gateway",
    tone: "muted",
  },
  {
    kind: "command",
    text: "sudo tailscale serve --bg --https=8443 http://127.0.0.1:8787",
  },
];

mountGatewayTerminals();
highlightTypescriptSnippets();
mountMicroFlow();
mountArchitectureStories();

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
const activeToolChoreography = new Map<string, ToolChoreography>();
let toolCallSequence = 0;

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
    "Checking gateway access",
    "Runtime card and application grant",
    "active",
  );
  status.textContent = "Checking the gateway and application grant…";
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
      status.textContent = "Opening the gateway for approval…";
      connectionState.textContent = "Approval required";
      updateActivity(
        activeConnectionActivity,
        "Application approval required",
        "Opening the gateway-owned consent page",
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
  status.textContent = "";
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
  clearToolChoreography();
  traceSummary.textContent = "Sending task";
  status.textContent = "The connected runtime is working…";
  document.body.dataset["demo"] = "running";
  const surface = requireElement(`scenario-${selectedScenario}`);
  delete surface.dataset["changed"];

  try {
    const prompt = [
      `[Agent Connect demo scenario: ${selectedScenario}]`,
      "Use get_current_app_state to inspect the live app before acting.",
      "Use the selected app's tools to write the result back into the page.",
      "",
      `User request: ${promptInput.value}`,
    ].join("\n");
    for await (const taskEvent of connection.session.streamTask(prompt)) {
      appendEvent(taskEvent);
      await paceVisibleTaskEvent(taskEvent);
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
      beginToolChoreography(event.actionId, event.name);
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
      finishToolChoreography(event.actionId, event.name, event.isError);
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

type ToolChoreography = {
  badge: HTMLDivElement;
  surface: HTMLElement;
};

const TOOL_REQUEST_DWELL_MS = 650;
const TOOL_RESULT_DWELL_MS = 900;

function beginToolChoreography(actionId: string, name: string): void {
  const surface = requireElement(`scenario-${selectedScenario}`);
  surface.dataset["agentMotion"] = "request";
  const stack = ensureToolFlightStack(surface);
  stack.replaceChildren();
  const badge = document.createElement("div");
  badge.className = "tool-flight";
  badge.dataset["phase"] = "request";
  const call = document.createElement("span");
  toolCallSequence += 1;
  call.textContent = `call-${toolCallSequence}`;
  const toolName = document.createElement("strong");
  toolName.textContent = name;
  badge.append(call, toolName);
  stack.append(badge);
  activeToolChoreography.set(actionId, {
    badge,
    surface,
  });
}

function finishToolChoreography(
  actionId: string,
  name: string,
  isError: boolean,
): void {
  const choreography = activeToolChoreography.get(actionId);
  if (!choreography) return;
  activeToolChoreography.delete(actionId);
  choreography.badge.dataset["phase"] = isError ? "error" : "result";
  const toolName = choreography.badge.querySelector("strong");
  if (toolName)
    toolName.textContent = `${name} ${isError ? "failed" : "result ✓"}`;
  choreography.surface.dataset["agentMotion"] = isError ? "error" : "result";
  window.setTimeout(() => {
    if (!choreography.badge.isConnected) return;
    choreography.badge.remove();
    const stack = choreography.surface.querySelector(".tool-flight-stack");
    if (!stack?.childElementCount) {
      stack?.remove();
      delete choreography.surface.dataset["agentMotion"];
    }
  }, 1_100);
}

async function paceVisibleTaskEvent(event: AgentTaskEvent): Promise<void> {
  if (event.type !== "tool.requested" && event.type !== "tool.completed")
    return;
  const duration =
    event.type === "tool.requested"
      ? TOOL_REQUEST_DWELL_MS
      : TOOL_RESULT_DWELL_MS;
  await new Promise<void>((resolve) =>
    window.setTimeout(resolve, reducedMotion() ? 120 : duration),
  );
}

function ensureToolFlightStack(surface: HTMLElement): HTMLDivElement {
  const existing = surface.querySelector<HTMLDivElement>(".tool-flight-stack");
  if (existing) return existing;
  const stack = document.createElement("div");
  stack.className = "tool-flight-stack";
  stack.setAttribute("aria-hidden", "true");
  surface.append(stack);
  return stack;
}

function clearToolChoreography(): void {
  activeToolChoreography.clear();
  toolCallSequence = 0;
  for (const surface of document.querySelectorAll<HTMLElement>(
    ".scenario-surface",
  )) {
    surface.querySelector(".tool-flight-stack")?.remove();
    delete surface.dataset["agentMotion"];
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
    if (fields.childElementCount === 0) {
      const noInputs = document.createElement("p");
      noInputs.className = "tool-no-inputs";
      noInputs.textContent =
        "No inputs — reads the selected view at call time.";
      contract.append(heading, description, noInputs);
    } else {
      contract.append(heading, description, inputHeading, fields);
    }
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

function mountArchitectureStories(): void {
  for (const host of document.querySelectorAll<HTMLElement>(
    "[data-architecture-story]",
  )) {
    const layout =
      host.dataset["storyLayout"] === "mobile" ? "mobile" : "desktop";
    host.className = "architecture-story";
    host.setAttribute("aria-labelledby", "architecture-story-title");
    host.innerHTML = architectureStoryMarkup(layout);
    if (layout === "desktop") mountFutureStory(host);
  }
}

function architectureStoryMarkup(layout: "desktop" | "mobile"): string {
  return `
    <div class="architecture-intro">
      <div>
        <h2 id="architecture-story-title">How it works today</h2>
        <p>A real browser-to-Codex path</p>
      </div>
    </div>

    <div class="current-architecture" role="img" aria-label="The web app lends browser tools through Tailscale Serve to the Agent Connect Gateway. Inside the user's boundary, the gateway uses OmniGENT and the codex-acp adapter to run Codex from the user's subscription.">
      <article class="architecture-app">
        <div class="architecture-browser-bar" aria-hidden="true"><i></i><i></i><i></i><span>yourapp.com</span></div>
        <div class="architecture-app-body">
          <code>@agent-connect/web</code>
          <p>Typed tools are declared for the session. Their handlers run here.</p>
          <ul>
            <li><i></i><code>create_project_tasks</code></li>
            <li><i></i><code>update_project_tasks</code></li>
            <li><i></i><code>move_project_tasks</code></li>
          </ul>
          <strong>Tools execute in the app</strong>
        </div>
      </article>

      <div class="architecture-handoff" aria-hidden="true"><span></span></div>

      <div class="architecture-boundary">
        <span class="boundary-label">User's boundary · laptop / VM</span>
        <div class="architecture-stack">
          <article class="architecture-layer architecture-layer-transport">
            <div><strong>Tailscale Serve</strong><span>private tailnet HTTPS</span></div>
            <p>Authenticated transport to a gateway listening on loopback.</p>
          </article>
          <article class="architecture-layer architecture-layer-gateway">
            <div><strong>Agent Connect Gateway</strong><span>trust core</span></div>
            <p>Identity, consent, origin- and tool-bound grants, opaque sessions, revocation, and recovery.</p>
          </article>
          <article class="architecture-layer architecture-layer-runtime">
            <div><strong>OmniGENT</strong><span>conductor</span></div>
            <p>Agent lifecycle and a request-scoped MCP relay for the app's tools.</p>
          </article>
          <article class="architecture-layer architecture-layer-adapter">
            <div><strong>codex-acp</strong><span>ACP adapter</span></div>
          </article>
          <article class="architecture-layer architecture-layer-agent">
            <div><strong>Codex</strong><span>user's subscription</span></div>
            <p>Reasons, streams events, and calls the tools lent by the app.</p>
          </article>
        </div>
        <aside class="judge-substitution">
          <strong>Public judge demo</strong>
          <span>At the agent layer, this Codex box is replaced by a deterministic ACP agent replaying Codex-authored tool plans. The public transport uses Tailscale Funnel; the SDK, gateway, grants, sessions, and browser tool loop remain live.</span>
        </aside>
      </div>
    </div>

    <div class="future-intro">
      <h2>Where this goes</h2>
      <p>Keep the trust boundary. Make everything around it replaceable.</p>
    </div>

    ${layout === "desktop" ? desktopFutureStoryMarkup() : mobileFutureStoryMarkup()}
  `;
}

function statusBadge(label: "proven" | "transitional" | "intended"): string {
  return `<span class="north-status north-status-${label}">${label}</span>`;
}

function desktopFutureStoryMarkup(): string {
  const axes = [
    {
      className: "north-conductor",
      label: "Conductor",
      current: "OmniGENT today",
      status: "transitional" as const,
      future: "any conductor or none",
    },
    {
      className: "north-agent",
      label: "Coding agent",
      current: "Codex",
      status: "proven" as const,
      future:
        "Codex · Claude Code<br><span>Pi · Agy · other compatible agents</span>",
    },
    {
      className: "north-transport",
      label: "Transport",
      current: "Tailscale",
      status: "proven" as const,
      future: "any secure tunnel",
    },
    {
      className: "north-deployment",
      label: "Deployment",
      current: "personal VM",
      status: "transitional" as const,
      future: "a simple packaged box",
    },
  ];
  const axisMarkup = axes
    .map(
      (axis) => `
        <article class="north-axis ${axis.className}">
          <span class="north-axis-label">${axis.label}</span>
          <div class="north-axis-stage">
            <div class="north-axis-current"><strong>${axis.current}</strong>${statusBadge(axis.status)}</div>
            <div class="north-axis-intended"><strong>${axis.future}</strong>${statusBadge("intended")}</div>
          </div>
        </article>`,
    )
    .join("");

  return `
    <div class="north-story" data-future-story data-story-phase="today">
      <div class="north-sticky">
        <div class="north-canvas" role="img" aria-label="Agent Connect keeps one stable control plane while the conductor, coding agent, transport, and deployment become replaceable.">
          <svg class="north-wires" viewBox="0 0 1100 660" preserveAspectRatio="none" aria-hidden="true">
            <path d="M345 188 H375 Q390 188 390 203 V226 H405" />
            <path d="M345 384 H375 Q390 384 390 369 V346 H405" />
            <path d="M755 188 H725 Q710 188 710 203 V226 H695" />
            <path d="M755 384 H725 Q710 384 710 369 V346 H695" />
          </svg>

          <div class="north-legend" aria-label="Architectural status">
            ${statusBadge("proven")}${statusBadge("transitional")}${statusBadge("intended")}
          </div>

          ${axisMarkup}

          <article class="north-control-plane">
            <span>control plane</span>
            <h3>Agent Connect</h3>
            <em>stays stable</em>
            <ul>
              <li>one identity you enroll once</li>
              <li>explicit consent, per app</li>
              <li>scoped grants that expire</li>
              <li>every action tracked</li>
              <li>one-click revocation</li>
            </ul>
          </article>

          <div class="north-roadmap">
            <div>
              <span>Where this goes</span>
              <strong>Support more setups while making usage simpler.</strong>
            </div>
            <ol>
              <li>plug in more agents</li>
              <li>decouple from the orchestrator</li>
              <li>simpler setup</li>
              <li>keep hardening trust</li>
            </ol>
          </div>
        </div>
      </div>
    </div>`;
}

function mobileFutureStoryMarkup(): string {
  const rows = [
    ["Conductor", "OmniGENT today", "any conductor or none"],
    ["Coding agent", "Codex", "Codex, Claude Code, Pi, Agy, and others"],
    ["Transport", "Tailscale", "any secure tunnel"],
    ["Deployment", "personal VM", "a simple packaged box"],
  ];
  return `
    <div class="mobile-north">
      <article class="mobile-north-core">
        <span>Agent Connect control plane</span>
        <strong>Identity, consent, scoped grants, sessions, and revocation stay stable.</strong>
      </article>
      <div class="mobile-north-axes">
        ${rows
          .map(
            ([label, current, future]) => `
              <article>
                <span>${label}</span>
                <div><del>${current}</del><i aria-hidden="true">→</i><strong>${future}</strong></div>
              </article>`,
          )
          .join("")}
      </div>
      <p><strong>Support more setups while making usage simpler.</strong></p>
    </div>`;
}

function mountFutureStory(host: HTMLElement): void {
  const story = host.querySelector<HTMLElement>("[data-future-story]");
  if (!story) return;
  const segment = (value: number, start: number, end: number) => {
    const linear = Math.min(1, Math.max(0, (value - start) / (end - start)));
    return 1 - Math.pow(1 - linear, 4);
  };
  const update = () => {
    const rect = story.getBoundingClientRect();
    const travel = Math.max(1, story.offsetHeight - window.innerHeight);
    const progress = Math.min(1, Math.max(0, -rect.top / travel));
    const time = progress * 3;
    const transitions = [
      ["--conductor-progress", 1.06, 1.55],
      ["--agent-progress", 1.15, 1.64],
      ["--transport-progress", 1.24, 1.73],
      ["--deployment-progress", 1.33, 1.82],
      ["--stable-progress", 1.05, 1.3],
      ["--legend-progress", 0.3, 0.6],
      ["--roadmap-progress", 2.02, 2.25],
      ["--roadmap-one", 2.1, 2.35],
      ["--roadmap-two", 2.19, 2.44],
      ["--roadmap-three", 2.28, 2.53],
      ["--roadmap-four", 2.37, 2.62],
    ] as const;
    for (const [property, start, end] of transitions) {
      story.style.setProperty(property, String(segment(time, start, end)));
    }
    story.dataset["storyPhase"] =
      time < 1.05 ? "today" : time < 2.02 ? "opening" : "future";
  };

  update();
  if (reducedMotion() || matchMedia("(max-width: 700px)").matches) return;
  let frame: number | undefined;
  const schedule = () => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      update();
    });
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
}

type MicroFlowMover = {
  element: SVGCircleElement;
  from: number;
  to: number;
  start: number;
  end: number;
  offsetY: number;
};

function mountMicroFlow(): void {
  const host = document.querySelector<HTMLElement>("[data-micro-flow]");
  if (!host) return;

  const mover = (name: string): SVGCircleElement | undefined =>
    host.querySelector<SVGCircleElement>(`[data-micro-mover="${name}"]`) ??
    undefined;
  const task = mover("task");
  const callOne = mover("call-1");
  const resultOne = mover("result-1");
  const callTwo = mover("call-2");
  const resultTwo = mover("result-2");
  if (!task || !callOne || !resultOne || !callTwo || !resultTwo) return;

  const movers: readonly MicroFlowMover[] = [
    { element: task, from: 40, to: 600, start: 0.3, end: 2, offsetY: 0 },
    {
      element: callOne,
      from: 600,
      to: 40,
      start: 2.5,
      end: 3.8,
      offsetY: -7,
    },
    {
      element: resultOne,
      from: 40,
      to: 600,
      start: 4.1,
      end: 5.4,
      offsetY: 7,
    },
    {
      element: callTwo,
      from: 600,
      to: 40,
      start: 5.7,
      end: 7,
      offsetY: -7,
    },
    {
      element: resultTwo,
      from: 40,
      to: 600,
      start: 7.3,
      end: 8.6,
      offsetY: 7,
    },
  ];
  const appRing = host.querySelector<SVGCircleElement>(
    '[data-micro-ring="app"]',
  );
  const connectorRing = host.querySelector<SVGCircleElement>(
    '[data-micro-ring="connector"]',
  );
  const agentRing = host.querySelector<SVGCircleElement>(
    '[data-micro-ring="agent"]',
  );
  if (!appRing || !connectorRing || !agentRing) return;
  const rings = {
    app: appRing,
    connector: connectorRing,
    agent: agentRing,
  };

  updateMicroFlow(0, movers, rings);
  if (reducedMotion()) return;

  const startedAt = performance.now();
  let animationFrame: number | undefined;
  let visible = false;
  const tick = (now: number) => {
    if (!visible) return;
    updateMicroFlow(((now - startedAt) / 1000) % 10, movers, rings);
    animationFrame = requestAnimationFrame(tick);
  };
  const setVisible = (nextVisible: boolean) => {
    visible = nextVisible;
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    animationFrame = nextVisible ? requestAnimationFrame(tick) : undefined;
  };

  if (!("IntersectionObserver" in window)) {
    setVisible(true);
    return;
  }
  const observer = new IntersectionObserver(
    ([entry]) => setVisible(entry?.isIntersecting === true),
    { threshold: 0.1 },
  );
  observer.observe(host);
}

function updateMicroFlow(
  time: number,
  movers: readonly MicroFlowMover[],
  rings: Readonly<Record<"app" | "connector" | "agent", SVGCircleElement>>,
): void {
  for (const mover of movers) {
    const progress = microSegment(time, mover.start, mover.end);
    mover.element.setAttribute(
      "cx",
      String(mover.from + (mover.to - mover.from) * progress),
    );
    mover.element.setAttribute("cy", String(40 + mover.offsetY));
    mover.element.setAttribute(
      "opacity",
      String(
        progress <= 0.005 || progress >= 0.995
          ? 0
          : Math.min(1, progress / 0.1, (1 - progress) / 0.1),
      ),
    );
  }

  updateMicroFlowRing(
    rings.app,
    microClamp(microBell(time, 3.5, 4.6) + microBell(time, 6.7, 7.8), 0, 1),
  );
  updateMicroFlowRing(
    rings.connector,
    microClamp(
      microBell(time, 0.8, 1.6) +
        microBell(time, 2.9, 3.6) +
        microBell(time, 4.6, 5.3) +
        microBell(time, 6.1, 6.8) +
        microBell(time, 7.8, 8.5),
      0,
      1,
    ),
  );
  updateMicroFlowRing(
    rings.agent,
    microClamp(
      microBell(time, 1.6, 2.8) +
        microBell(time, 5.1, 6) +
        microBell(time, 8.3, 9.4),
      0,
      1,
    ),
  );
}

function updateMicroFlowRing(ring: SVGCircleElement, heat: number): void {
  ring.setAttribute("r", String(9 + 2.5 * heat));
  ring.setAttribute("opacity", String(0.25 + 0.5 * heat));
}

function microSegment(time: number, start: number, end: number): number {
  const progress = microClamp((time - start) / (end - start), 0, 1);
  return 1 - Math.pow(1 - progress, 3);
}

function microBell(time: number, start: number, end: number): number {
  return Math.sin(microClamp((time - start) / (end - start), 0, 1) * Math.PI);
}

function microClamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
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
  connectButton.hidden = connection !== undefined;
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
    runButtonLabel.textContent = busy ? "Working…" : "Send prompt";
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
