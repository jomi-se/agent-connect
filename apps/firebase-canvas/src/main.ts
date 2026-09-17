import {
  AgentSession,
  OpenClawConnectionError,
  beginOpenClawAuthorization,
  completeOpenClawAuthorization,
  createOpenClawAccessTokenGetter,
  createOpenClawResponsesProvider,
  discoverOpenClawProvider,
  normalizeOpenClawProviderUrl,
  parseOpenClawAuthorizationTransaction,
  parseOpenClawConnection,
  revokeOpenClawConnection,
  serializeOpenClawAuthorizationTransaction,
  serializeOpenClawConnection,
  type AgentTaskEvent,
  type JsonObject,
  type OpenClawConnection,
} from "@open-agent-connect/web";
import {
  createDemoTools,
  DEFAULT_PROMPTS,
  SCENARIO_TOOL_NAMES,
  type DemoScenario,
} from "./demo-tools.js";

const STORAGE_PROVIDER = "agent-connect.canvas.provider";
const STORAGE_CONNECTION = "agent-connect.canvas.connection";
const STORAGE_TRANSACTION = "agent-connect.canvas.oauth-transaction";
const tools = createDemoTools();

const connectForm = element<HTMLFormElement>("connect-form");
const gatewayInput = element<HTMLInputElement>("gateway-address");
const connectButton = element<HTMLButtonElement>("connect");
const connectLabel = connectButton.querySelector<HTMLElement>(
  ".connect-button-label",
);
const disconnectButton = element<HTMLButtonElement>("disconnect");
const tryButton = element<HTMLButtonElement>("try-demo");
const taskForm = element<HTMLFormElement>("task-form");
const promptInput = element<HTMLTextAreaElement>("prompt");
const runButton = element<HTMLButtonElement>("run");
const taskDrawer = document.querySelector<HTMLElement>(".task-drawer");
const status = element<HTMLOutputElement>("status");
const connectionState = element<HTMLElement>("connection-state");
const traceSummary = element<HTMLElement>("trace-summary");
const activityFeed = element<HTMLOListElement>("activity-feed");
const eventLog = element<HTMLPreElement>("events");
const clearTraceButton = element<HTMLButtonElement>("clear-trace");
const showToolsButton = element<HTMLButtonElement>("show-tools");
const toolDialog = element<HTMLDialogElement>("tool-dialog");
const toolDialogTitle = element<HTMLElement>("tool-dialog-title");
const toolList = element<HTMLElement>("tool-list");

let selectedScenario: DemoScenario = "project-board";
let connection: OpenClawConnection | undefined;
let session: AgentSession | undefined;
let running = false;

gatewayInput.value = localStorage.getItem(STORAGE_PROVIDER) ?? "";
selectScenario(selectedScenario);
seedActivity();

for (const tab of document.querySelectorAll<HTMLButtonElement>(
  "[data-scenario-tab]",
)) {
  const scenario = tab.dataset["scenarioTab"];
  if (isDemoScenario(scenario)) {
    tab.id = `scenario-tab-${scenario}`;
    tab.setAttribute("aria-controls", `scenario-${scenario}`);
    const panel = element(`scenario-${scenario}`);
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
  }
  tab.addEventListener("click", () => {
    const next = tab.dataset["scenarioTab"];
    if (isDemoScenario(next) && !running) selectScenario(next);
  });
  tab.addEventListener("keydown", (event) => moveScenarioFocus(event, tab));
}

connectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void startAuthorization();
});
disconnectButton.addEventListener("click", () => void disconnect());
tryButton.addEventListener("click", () => void runSimulation());
taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runConnectedTask();
});
clearTraceButton.addEventListener("click", resetActivity);
showToolsButton.addEventListener("click", showScenarioTools);

void resumeOrRestore();

async function startAuthorization(): Promise<void> {
  setConnectBusy(true);
  status.textContent = "Checking this gateway and preparing approval…";
  try {
    const providerUrl = agentConnectOpenClawPluginProviderUrl(
      gatewayInput.value,
    );
    localStorage.setItem(STORAGE_PROVIDER, providerUrl);
    addActivity("app", "Canvas", "Connection requested", providerUrl);
    const provider = await discoverOpenClawProvider({
      providerUrl,
      experience: "https",
    });
    addActivity(
      "gateway",
      "Agent Connect",
      "Gateway discovered",
      "OAuth metadata verified",
    );
    const started = await beginOpenClawAuthorization({
      provider,
      redirectUri: callbackUri(),
      tools,
      callerContext: { scenario: selectedScenario },
    });
    sessionStorage.setItem(
      STORAGE_TRANSACTION,
      serializeOpenClawAuthorizationTransaction(started.transaction),
    );
    status.textContent = "Opening your gateway for approval…";
    location.assign(started.authorizationUrl);
  } catch (error) {
    showConnectionError(error);
    setConnectBusy(false);
  }
}

async function resumeOrRestore(): Promise<void> {
  const callback = new URL(location.href);
  const hasCallback =
    callback.searchParams.has("code") || callback.searchParams.has("error");
  if (hasCallback) {
    await completeAuthorization(callback);
    return;
  }
  const saved = sessionStorage.getItem(STORAGE_CONNECTION);
  if (!saved) return;
  try {
    const restored = await parseOpenClawConnection(saved, {
      clientId: location.origin,
    });
    establishConnection(restored, "Connection restored for this tab");
  } catch {
    sessionStorage.removeItem(STORAGE_CONNECTION);
  }
}

async function completeAuthorization(callback: URL): Promise<void> {
  const serialized = sessionStorage.getItem(STORAGE_TRANSACTION);
  if (!serialized) {
    status.textContent =
      "The saved approval request is missing. Connect again.";
    return;
  }
  setConnectBusy(true);
  try {
    const transaction = parseOpenClawAuthorizationTransaction(serialized);
    const provider = await discoverOpenClawProvider({
      providerUrl: transaction.providerOrigin,
      experience: transaction.experience,
    });
    const completed = await completeOpenClawAuthorization({
      provider,
      redirectUri: callbackUri(),
      transaction,
      callbackUrl: callback.href,
    });
    sessionStorage.setItem(
      STORAGE_CONNECTION,
      serializeOpenClawConnection(completed),
    );
    sessionStorage.removeItem(STORAGE_TRANSACTION);
    history.replaceState({}, "", callbackUri());
    establishConnection(completed, "OAuth approval completed");
  } catch (error) {
    showConnectionError(error);
  } finally {
    setConnectBusy(false);
  }
}

function establishConnection(
  nextConnection: OpenClawConnection,
  detail: string,
): void {
  connection = nextConnection;
  session = createSession(nextConnection);
  disconnectButton.hidden = false;
  connectionState.innerHTML = "<i></i>Agent connected";
  status.textContent = "Connected. The approved application tools are ready.";
  taskDrawer?.setAttribute("data-open", "true");
  addActivity("gateway", "Agent Connect", "Access granted", detail);
}

function createSession(initial: OpenClawConnection): AgentSession {
  let current = initial;
  const getAccessToken = createOpenClawAccessTokenGetter({
    getConnection: () => current,
    saveConnection: (updated, expected) => {
      if (current !== expected || connection !== expected) return false;
      current = updated;
      connection = updated;
      sessionStorage.setItem(
        STORAGE_CONNECTION,
        serializeOpenClawConnection(updated),
      );
      return true;
    },
  });
  return new AgentSession({
    provider: createOpenClawResponsesProvider({
      connection: initial,
      getAccessToken,
    }),
    tools,
  });
}

async function disconnect(): Promise<void> {
  if (!connection) return;
  disconnectButton.disabled = true;
  status.textContent = "Revoking this application's grant…";
  try {
    await revokeOpenClawConnection({ connection });
    clearConnection();
    status.textContent = "Disconnected and revoked. You can reconnect anytime.";
    addActivity(
      "gateway",
      "Agent Connect",
      "Grant revoked",
      "This application no longer has access",
    );
  } catch (error) {
    showConnectionError(error);
  } finally {
    disconnectButton.disabled = false;
  }
}

function clearConnection(): void {
  connection = undefined;
  session = undefined;
  sessionStorage.removeItem(STORAGE_CONNECTION);
  sessionStorage.removeItem(STORAGE_TRANSACTION);
  disconnectButton.hidden = true;
  connectionState.innerHTML = "<i></i>Ready to demonstrate";
  taskDrawer?.removeAttribute("data-open");
}

async function runSimulation(): Promise<void> {
  if (running) return;
  setRunning(true, "simulation");
  resetActivity();
  addActivity(
    "app",
    appName(selectedScenario),
    "User started demo",
    DEFAULT_PROMPTS[selectedScenario],
  );
  await pause(180);
  addActivity(
    "gateway",
    "Agent Connect",
    "Simulated request",
    "No network, account, or model usage",
  );
  await pause(220);
  addActivity(
    "agent",
    "Demo agent",
    "Planning next steps",
    "Deterministic client-side sequence",
  );
  try {
    for (const step of simulationSteps(selectedScenario)) {
      await runSimulatedTool(step.name, step.arguments);
    }
    addActivity(
      "app",
      appName(selectedScenario),
      "Task complete",
      "The application was updated through its own tools",
    );
    traceSummary.textContent = "Simulated task completed";
    connectionState.innerHTML = "<i></i>Demo complete";
  } catch (error) {
    addActivity(
      "app",
      appName(selectedScenario),
      "Demo stopped",
      errorMessage(error),
    );
  } finally {
    setRunning(false, "simulation");
  }
}

async function runSimulatedTool(name: string, arguments_: JsonObject) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing demo tool: ${name}`);
  const actionId = `demo-${crypto.randomUUID()}`;
  beginToolChoreography(actionId, name);
  addActivity("tool", "Browser tool", name, "Executing in this application");
  await pause(260);
  await tool.execute(arguments_, {
    connectionId: "deterministic-demo",
    toolName: name,
    meta: null,
    actionId,
  });
  finishToolChoreography(actionId, name, false);
  addActivity("agent", "Demo agent", `${name} returned`, "Result correlated");
  await pause(260);
}

async function runConnectedTask(): Promise<void> {
  if (!session || running) {
    status.textContent = "Connect your agent before running a live task.";
    return;
  }
  setRunning(true, "connected");
  status.textContent = "Your agent is working…";
  const surface = element(`scenario-${selectedScenario}`);
  delete surface.dataset["changed"];
  try {
    const prompt = [
      `[Agent Connect demo scenario: ${selectedScenario}]`,
      "Use get_current_app_state before acting.",
      "Use this application's tools to write the result back into the page.",
      "",
      `User request: ${promptInput.value}`,
    ].join("\n");
    const stream = session.canContinueTask
      ? session.streamContinuation(prompt)
      : session.streamTask(prompt);
    for await (const event of stream) {
      appendEvent(event);
      await paceEvent(event);
      if (event.type === "task.completed") {
        status.textContent = "The app was updated through its own tools.";
      }
      if (event.type === "task.failed") throw new Error(event.error.message);
    }
  } catch (error) {
    status.textContent = errorMessage(error);
    if (!session.canContinueTask)
      session = connection ? createSession(connection) : undefined;
  } finally {
    setRunning(false, "connected");
  }
}

function appendEvent(event: AgentTaskEvent): void {
  eventLog.textContent += `${JSON.stringify(event)}\n`;
  if (event.type === "task.started") {
    addActivity("agent", "Connected agent", "Task started", selectedScenario);
  } else if (event.type === "tool.requested") {
    beginToolChoreography(event.actionId, event.name);
    addActivity("tool", "Browser tool", event.name, "Requested by your agent");
  } else if (event.type === "tool.completed") {
    finishToolChoreography(event.actionId, event.name, event.isError);
    addActivity(
      "gateway",
      "Agent Connect",
      `${event.name} result`,
      event.isError
        ? "Tool returned an error"
        : "Result returned to your agent",
    );
  } else if (event.type === "task.completed") {
    addActivity("app", appName(selectedScenario), "Task complete", event.text);
    traceSummary.textContent = "Live task completed";
  } else if (event.type === "task.failed") {
    addActivity("agent", "Connected agent", "Task failed", event.error.message);
  }
}

type SimulationStep = { name: string; arguments: JsonObject };
function simulationSteps(scenario: DemoScenario): readonly SimulationStep[] {
  if (scenario === "project-board") {
    return [
      { name: "get_current_app_state", arguments: {} },
      {
        name: "create_project_tasks",
        arguments: {
          tasks: [
            {
              id: "launch-checklist",
              title: "Prepare launch checklist",
              priority: "high",
              status: "doing",
            },
          ],
        },
      },
      {
        name: "update_project_tasks",
        arguments: {
          changes: [
            {
              id: "pricing",
              title: "Confirm launch pricing",
              priority: "high",
            },
          ],
        },
      },
    ];
  }
  if (scenario === "document-review") {
    return [
      { name: "get_current_app_state", arguments: {} },
      {
        name: "add_document_comments",
        arguments: {
          comments: [
            {
              quote:
                "Our new workspace makes every team exactly twice as productive.",
              kind: "fact",
              comment: "This needs evidence or a more measured claim.",
            },
            {
              quote: "The first graphical web browser was released in 1989.",
              kind: "fact",
              comment: "The date and description are inaccurate.",
            },
          ],
        },
      },
      {
        name: "replace_document_text",
        arguments: {
          replacements: [
            {
              quote:
                "Basically, we really think this is perhaps the best way for everyone to work better.",
              replacement:
                "It gives teams a calmer place to make progress together.",
            },
          ],
        },
      },
    ];
  }
  return [
    { name: "get_current_app_state", arguments: {} },
    {
      name: "add_product_assessment",
      arguments: {
        verdict:
          "Good battery life, but adult sizing and unrestricted volume make this a mixed fit for an eight-year-old.",
        kidFit: "mixed",
        concerns: ["Adult ear-cup fit", "No child-specific volume limit"],
      },
    },
    {
      name: "add_price_comparison",
      arguments: {
        listedPrice: 129,
        fairLow: 85,
        fairHigh: 105,
        verdict: "The listed price is above the typical fair range.",
      },
    },
    {
      name: "add_product_alternatives",
      arguments: {
        alternatives: [
          {
            name: "JBL Junior 320BT",
            price: 49,
            reason: "Child-sized with a built-in volume limit.",
            url: "https://example.com/jbl-junior",
          },
        ],
      },
    },
  ];
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

function seedActivity(): void {
  addActivity(
    "app",
    "Northstar",
    "Workbench ready",
    "Choose Try the demo or connect your agent",
  );
  addActivity(
    "gateway",
    "Agent Connect",
    "No grant required",
    "The deterministic demo stays in this browser",
  );
  addActivity(
    "agent",
    "Your agent",
    "Not connected",
    "The HTTPS OAuth path is available alongside the demo",
  );
}

function resetActivity(): void {
  activityFeed.replaceChildren();
  eventLog.textContent = "";
  traceSummary.textContent = "No events yet";
}

type ActivityKind = "app" | "gateway" | "agent" | "tool";
function addActivity(
  kind: ActivityKind,
  actor: string,
  event: string,
  detail: string,
): HTMLLIElement {
  const item = document.createElement("li");
  item.dataset["kind"] = kind;
  const time = document.createElement("time");
  time.textContent = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
  const actorCell = document.createElement("span");
  actorCell.className = "actor";
  actorCell.textContent = actor;
  const eventCell = document.createElement("span");
  eventCell.textContent = event;
  const detailCell = document.createElement("span");
  detailCell.className = "activity-detail";
  detailCell.textContent = detail;
  item.append(time, actorCell, eventCell, detailCell);
  activityFeed.append(item);
  return item;
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
    contract.append(heading, description);
    toolList.append(contract);
  }
  toolDialog.showModal();
}

const activeFlights = new Map<string, HTMLElement>();
function beginToolChoreography(actionId: string, name: string): void {
  const surface = element(`scenario-${selectedScenario}`);
  let stack = surface.querySelector<HTMLElement>(".tool-flight-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "tool-flight-stack";
    stack.setAttribute("aria-hidden", "true");
    surface.append(stack);
  }
  const badge = document.createElement("div");
  badge.className = "tool-flight";
  badge.innerHTML = `<span>tool call</span><strong>${escapeHtml(name)}</strong>`;
  stack.replaceChildren(badge);
  activeFlights.set(actionId, badge);
}

function finishToolChoreography(
  actionId: string,
  name: string,
  isError: boolean,
): void {
  const badge = activeFlights.get(actionId);
  if (!badge) return;
  activeFlights.delete(actionId);
  badge.dataset["phase"] = isError ? "error" : "result";
  const strong = badge.querySelector("strong");
  if (strong) strong.textContent = `${name} ${isError ? "failed" : "✓"}`;
  window.setTimeout(() => badge.remove(), 900);
}

function setRunning(value: boolean, mode: "simulation" | "connected"): void {
  running = value;
  tryButton.disabled = value;
  runButton.disabled = value;
  for (const tab of document.querySelectorAll<HTMLButtonElement>(
    "[data-scenario-tab]",
  ))
    tab.disabled = value;
  if (mode === "simulation") {
    const label = tryButton.querySelector<HTMLElement>(".demo-button-label");
    if (label) label.textContent = value ? "Running demo…" : "Try the demo";
  } else {
    const label = runButton.querySelector<HTMLElement>(".button-label");
    if (label)
      label.textContent = value ? "Agent working…" : "Run with connected agent";
  }
}

function setConnectBusy(value: boolean): void {
  connectButton.disabled = value;
  gatewayInput.disabled = value;
  if (connectLabel)
    connectLabel.textContent = value
      ? "Preparing OAuth…"
      : "Connect with OAuth";
}

function showConnectionError(error: unknown): void {
  const message = errorMessage(error);
  status.textContent = message;
  addActivity("gateway", "Agent Connect", "Connection stopped", message);
  connectionState.innerHTML = "<i></i>Connection needs attention";
  if (
    error instanceof OpenClawConnectionError &&
    (error.code === "connection_expired" ||
      error.code === "reauthorization_required")
  )
    clearConnection();
}

function moveScenarioFocus(
  event: KeyboardEvent,
  current: HTMLButtonElement,
): void {
  const tabs = [
    ...document.querySelectorAll<HTMLButtonElement>("[data-scenario-tab]"),
  ];
  const index = tabs.indexOf(current);
  let next = index;
  if (event.key === "ArrowRight" || event.key === "ArrowDown")
    next = (index + 1) % tabs.length;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
    next = (index - 1 + tabs.length) % tabs.length;
  else return;
  event.preventDefault();
  const tab = tabs[next];
  const scenario = tab?.dataset["scenarioTab"];
  if (tab && isDemoScenario(scenario)) {
    selectScenario(scenario);
    tab.focus();
  }
}

function callbackUri(): string {
  const configuredOrigin = import.meta.env[
    "VITE_AGENT_CONNECT_REDIRECT_ORIGIN"
  ] as string | undefined;
  const origin = configuredOrigin?.trim() || location.origin;
  return new URL(location.pathname, `${origin}/`).href;
}
function agentConnectOpenClawPluginProviderUrl(value: string): string {
  const normalized = normalizeOpenClawProviderUrl(value);
  const url = new URL(normalized);
  return url.pathname === "/" ? `${url.origin}/agent-connect` : normalized;
}
function scenarioTitle(value: DemoScenario): string {
  if (value === "project-board") return "Project board";
  if (value === "document-review") return "Document review";
  return "Product research";
}
function appName(value: DemoScenario): string {
  if (value === "project-board") return "Northstar";
  if (value === "document-review") return "Fieldnotes";
  return "Everyday";
}
function isDemoScenario(value: string | undefined): value is DemoScenario {
  return (
    value === "project-board" ||
    value === "document-review" ||
    value === "product-research"
  );
}
function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Try again.";
}
function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
async function paceEvent(event: AgentTaskEvent): Promise<void> {
  if (event.type === "tool.requested" || event.type === "tool.completed")
    await pause(320);
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}
function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}
