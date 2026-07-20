# Agent Connect reactive flow visualization brief

This document is a self-contained handoff for designing a replacement for the
current static Agent Connect flow visualization. The designer receiving it does
not have access to the repository.

## What Agent Connect does

Agent Connect lets a web application expose narrowly scoped, app-native tools
to a coding agent owned by the user, such as Codex or Claude Code.

The application developer integrates the browser SDK. The user runs the Agent
Connect gateway beside their coding agent, on infrastructure they control. The
public application API remains agent- and harness-neutral; Codex, OmniGENT,
ACP, and transport-specific behavior stay behind the gateway's internal adapter
boundary.

The central idea is not “send a prompt through three boxes.” It is a live,
bidirectional borrowing of application capabilities:

- the application temporarily lends selected tools to the user's agent;
- the agent requests actions using those tools;
- the application remains the authority that executes the actions;
- correlated results return to the agent so it can continue reasoning;
- one task may produce no tool calls, one tool call, or many tool calls.

## Ownership boundaries

### Web application

Owns its interface, application data, tool definitions, and tool execution. The
coding agent does not directly manipulate the DOM or application database.

### Agent Connect SDK

Provides the application with a provider-neutral browser API for authorization,
sessions, streamed tasks, and application-owned tools.

### Agent Connect gateway

Owns connector identity, application authorization, grants, revocation,
sessions, and internal runtime adapters. It runs inside a boundary selected by
the agent owner.

### Coding agent

Codex, Claude Code, or another compatible user-owned runtime. It runs in the
user's chosen environment and decides whether and when to request application
tools.

## The two phases the visualization must distinguish

### 1. Connection and authorization

1. The web application presents its identity, exact origin, callback, and
   declared tools.
2. The gateway verifies the request and its connector-owned authorization
   state.
3. The user authorizes that specific application and tool set.
4. The browser receives an opaque, revocable, application-bound grant.
5. The SDK establishes an opaque Agent Connect session with the selected
   runtime.

Authorization is a trust decision, not proof that an application is benign.
The consent surface must make the exact application origin and requested tools
clear to the user.

### 2. Live task execution

1. The user asks the connected coding agent to perform something in the app.
2. The task travels through the SDK and gateway to the user-owned runtime.
3. The coding agent reasons about the task and may stream text.
4. The agent may request zero, one, or many tools defined by the application.
5. Each tool request travels back through the gateway to the browser.
6. The web application executes the tool and visibly changes its own state.
7. The correlated result returns through the gateway to the coding agent.
8. The agent may request more tools, stream more text, finish, or fail.

The task initially travels from the app toward the coding agent. Tool requests
then reverse direction and travel from the coding agent back into the app. That
direction reversal is the most important relationship to make legible.

## Current demo applications and tools

The demo presents three visually independent third-party applications. The
public demo authorizes one fixed superset of all ten tools so the visitor does
not repeat consent when switching examples. Every scenario first uses the
shared `get_current_app_state` tool to read the selected live view.

```ts
const toolsByScenario = {
  "project-board": [
    "get_current_app_state",
    "create_project_tasks",
    "update_project_tasks",
    "move_project_tasks",
  ],

  "document-review": [
    "get_current_app_state",
    "add_document_comments",
    "replace_document_text",
    "format_document_blocks",
  ],

  "product-research": [
    "get_current_app_state",
    "add_product_assessment",
    "add_price_comparison",
    "add_product_alternatives",
  ],
} as const;
```

The project board is branded **Northstar**, the editorial application is
**Fieldnotes**, and the commerce application is **Everyday**. They use simple
HTML/CSS lettermarks rather than external logo assets.

## Existing runtime event shapes

The application already receives the following events from
`connection.session.streamTask(prompt)`:

```ts
type AgentTaskEvent =
  | { type: "task.started" }
  | { type: "text.delta"; delta: string }
  | {
      type: "tool.requested";
      actionId: string;
      name: string;
      arguments: unknown;
    }
  | {
      type: "tool.completed";
      actionId: string;
      name: string;
      isError: boolean;
    }
  | { type: "task.completed"; text: string }
  | {
      type: "task.failed";
      error: {
        code: string;
        message: string;
      };
    };
```

`actionId` provides correlation between a tool request and its result:

```ts
{
  type: "tool.requested",
  actionId: "exec-7a71ef1d",
  name: "move_project_tasks",
  arguments: {
    moves: [{ id: "pricing", status: "doing" }]
  }
}
```

Later, the application receives:

```ts
{
  type: "tool.completed",
  actionId: "exec-7a71ef1d",
  name: "move_project_tasks",
  isError: false
}
```

Between those two events, the SDK invokes the browser-owned tool and the
visible third-party app changes. A successful demo tool marks its selected app
surface with `data-changed="true"`.

## Proposed visualization event contract

The underlying lifecycle points already exist, but the application does not yet
publish a dedicated visualization event bus. The following is the proposed
decoupled contract. Do not describe it as already implemented.

```ts
type DemoScenario = "project-board" | "document-review" | "product-research";

type DemoFlowEvent =
  // Connection and authorization
  | { type: "connector.checking" }
  | {
      type: "authorization.required";
      appId: string;
      origin: string;
      tools: string[];
    }
  | { type: "authorization.completed" }
  | {
      type: "runtime.connected";
      runtime: "deterministic-acp" | "codex-through-omnigent";
    }
  | { type: "authorization.revoked" }

  // Task execution
  | {
      type: "task.sent";
      scenario: DemoScenario;
      prompt: string;
    }
  | { type: "task.started" }
  | { type: "agent.text"; delta: string }
  | {
      type: "tool.requested";
      actionId: string;
      name: string;
      arguments: unknown;
    }
  | {
      type: "tool.completed";
      actionId: string;
      name: string;
      isError: boolean;
    }
  | { type: "task.completed"; text: string }
  | { type: "task.failed"; message: string };
```

Events will be dispatched on `window`:

```ts
function emitDemoFlow(detail: DemoFlowEvent): void {
  window.dispatchEvent(
    new CustomEvent<DemoFlowEvent>("agent-connect:demo-flow", {
      detail,
    }),
  );
}
```

The visualization should subscribe independently rather than inspect the
existing activity-feed DOM:

```ts
window.addEventListener("agent-connect:demo-flow", (event) => {
  const flow = (event as CustomEvent<DemoFlowEvent>).detail;
  visualization.handle(flow);
});
```

## Where the proposed events originate

### Connection and authorization

```ts
async function connectRuntime() {
  emitDemoFlow({ type: "connector.checking" });

  // Validate the signed runtime card and look for an existing app grant.

  if (!existingGrant) {
    emitDemoFlow({
      type: "authorization.required",
      appId: "agent-connect-demo",
      origin: location.origin,
      tools: tools.map((tool) => tool.name),
    });

    // Browser navigates to the connector-owned authorization page.
    location.assign(authorizationUrl);
    return;
  }

  await establishConnection(runtimeCard, existingGrant);
}
```

Authorization returns through a browser redirect. The page therefore reloads
before the completed state is emitted:

```ts
async function resumeAuthorization() {
  // Exchange the authorization code using PKCE.

  emitDemoFlow({ type: "authorization.completed" });
  await establishConnection(runtimeCard, grant.accessToken);
}
```

A successful runtime connection emits:

```ts
async function establishConnection(runtimeCard: RuntimeCard, grant: string) {
  connection = await connectAgent({
    baseUrl: runtimeCard.endpoint,
    appId: "agent-connect-demo",
    tools,
    accessToken: grant,
  });

  emitDemoFlow({
    type: "runtime.connected",
    runtime:
      runtimeCard.transportProfile === "public-demo"
        ? "deterministic-acp"
        : "codex-through-omnigent",
  });
}
```

Revoking the application's grant emits:

```ts
emitDemoFlow({ type: "authorization.revoked" });
```

### Task execution

```ts
async function runTask() {
  emitDemoFlow({
    type: "task.sent",
    scenario: selectedScenario,
    prompt: promptInput.value,
  });

  for await (const event of connection.session.streamTask(promptInput.value)) {
    forwardTaskEvent(event);
  }
}
```

The runtime events can be forwarded without coupling the visualization to the
existing session activity list:

```ts
function forwardTaskEvent(event: AgentTaskEvent) {
  switch (event.type) {
    case "task.started":
      emitDemoFlow({ type: "task.started" });
      break;

    case "text.delta":
      emitDemoFlow({
        type: "agent.text",
        delta: event.delta,
      });
      break;

    case "tool.requested":
      emitDemoFlow({
        type: "tool.requested",
        actionId: event.actionId,
        name: event.name,
        arguments: event.arguments,
      });
      break;

    case "tool.completed":
      emitDemoFlow({
        type: "tool.completed",
        actionId: event.actionId,
        name: event.name,
        isError: event.isError,
      });
      break;

    case "task.completed":
      emitDemoFlow({
        type: "task.completed",
        text: event.text,
      });
      break;

    case "task.failed":
      emitDemoFlow({
        type: "task.failed",
        message: event.error.message,
      });
      break;
  }
}
```

## Example complete event sequence

```ts
const exampleSequence: DemoFlowEvent[] = [
  { type: "connector.checking" },

  {
    type: "authorization.required",
    appId: "agent-connect-demo",
    origin: "https://agent-connect-demo.web.app",
    tools: [
      "get_current_app_state",
      "create_project_tasks",
      "update_project_tasks",
      "move_project_tasks",
    ],
  },

  { type: "authorization.completed" },

  {
    type: "runtime.connected",
    runtime: "deterministic-acp",
  },

  {
    type: "task.sent",
    scenario: "project-board",
    prompt: "Clean up the launch plan and move urgent work into progress.",
  },

  { type: "task.started" },

  {
    type: "agent.text",
    delta: "I’ll update the launch board.",
  },

  {
    type: "tool.requested",
    actionId: "call-1",
    name: "update_project_tasks",
    arguments: {
      changes: [
        {
          id: "pricing",
          title: "Confirm launch pricing and upgrade path",
          priority: "high",
        },
      ],
    },
  },

  {
    type: "tool.completed",
    actionId: "call-1",
    name: "update_project_tasks",
    isError: false,
  },

  {
    type: "tool.requested",
    actionId: "call-2",
    name: "move_project_tasks",
    arguments: {
      moves: [{ id: "pricing", status: "doing" }],
    },
  },

  {
    type: "tool.completed",
    actionId: "call-2",
    name: "move_project_tasks",
    isError: false,
  },

  {
    type: "task.completed",
    text: "The launch board has been updated.",
  },
];
```

The visualization must also handle valid shorter and longer sequences:

```text
task.sent → task.started → agent.text → task.completed
```

```text
task.sent → task.started → tool.requested → tool.completed
          → tool.requested → tool.completed → tool.requested
          → tool.completed → task.completed
```

```text
task.sent → task.started → tool.requested → tool.completed(isError)
          → task.failed
```

## Suggested mount point

The page has independently composed desktop and mobile templates. Both can
contain the same placeholder and share one event-driven implementation:

```html
<section aria-labelledby="flow-title">
  <div>
    <h2 id="flow-title">Watch the connection work</h2>
    <p>
      This view responds to the real authorization, task, tool, and result
      events from the demo above.
    </p>
  </div>

  <div
    data-flow-visualization
    aria-live="polite"
    aria-label="Live Agent Connect request flow"
  ></div>
</section>
```

## Visual identity and styling context

There are no external Agent Connect logo or illustration assets. The current
wordmark and actor mark are built with HTML and CSS. Demo-app logos are simple
CSS-backed lettermarks.

The established interface fonts are Figtree for the main UI and IBM Plex Mono
for code, commands, identifiers, and protocol evidence.

```css
:root {
  --background: oklch(1 0 0);
  --surface: oklch(0.972 0.006 250);
  --surface-strong: oklch(0.935 0.01 250);
  --ink: oklch(0.2 0.018 250);
  --muted: oklch(0.46 0.018 250);
  --border: oklch(0.85 0.012 250);

  /* Web application and its tools */
  --app: oklch(0.56 0.16 32.1);

  /* Agent Connect gateway, identity, and authorization */
  --connector: oklch(0.43 0.09 190);

  /* User-owned coding agent */
  --agent: oklch(0.52 0.15 275);

  /* Request currently moving or waiting */
  --signal: oklch(0.79 0.14 83);

  /* Completed operation */
  --success: oklch(0.48 0.12 150);

  /* Failure or revocation */
  --danger: oklch(0.5 0.18 25);

  --font-ui: "Figtree Variable", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;

  --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);
  --ease-out-quint: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
}
```

Color has semantic ownership:

- coral identifies the application and browser-owned tools;
- teal identifies the gateway, connector identity, and authorization boundary;
- periwinkle identifies the coding agent and runtime;
- amber identifies an in-flight or waiting request;
- green confirms completion;
- red is reserved for failure or revocation.

Do not reuse these colors as arbitrary decoration. Neutral surfaces should
remain the majority of the page.

## Key visual moments

1. **Application tools are declared.** Make the web app feel like the source of
   the capabilities, not a passive chat client.
2. **Authorization crosses a real boundary.** Show the exact app origin and
   requested tools moving toward a connector-owned consent decision.
3. **The task travels toward the agent.** The user's intent moves from the web
   app, through Agent Connect, to the user-owned runtime.
4. **The agent reasons.** Streaming text may arrive without any tool call.
5. **Direction reverses.** A tool request moves from the agent back toward the
   web app.
6. **The application acts.** Highlight or connect to the currently selected
   third-party app at the exact moment its browser-owned tool executes.
7. **The correlated result returns.** Use `actionId` to visually pair the
   request and result.
8. **The loop remains open.** Further agent text or tool calls can follow
   without advancing through a predefined path.
9. **Completion and failure are explicit.** Finish or fail the current task
   without implying the connection or grant disappeared.

Ideally, the visualization reacts to the live demo above it:

- authorization highlights the app-to-gateway trust boundary;
- sending a task moves activity from app to agent;
- agent text subtly activates the runtime endpoint;
- every actual tool request creates a temporary agent-to-app connection;
- the selected demo app highlights when it executes the tool;
- the tool result returns along the same correlated relationship;
- simultaneous or repeated calls accumulate dynamically rather than replacing
  a static five-step illustration.

## Motion requirements

Motion must explain state and direction rather than decorate the diagram.

- Use 100–150ms for immediate feedback and 200–300ms for state changes.
- Use natural ease-out curves; do not use bounce or elastic easing.
- Animate transforms and opacity for travel and focus. Avoid casually animating
  layout-driving properties.
- Keep the visualization interactive while animations are running.
- Do not require an animation to finish before the visitor can understand the
  current state.
- Provide a complete `prefers-reduced-motion` alternative. It should preserve
  event order, active relationships, request/result correlation, and textual
  status without animated travel.
- The diagram must work in the independently designed desktop and mobile
  compositions. Mobile should not be a scaled-down desktop canvas.

## Things to avoid

- static boxes connected by generic arrows;
- a permanently rendered linear pipeline;
- a fixed five-step progress indicator;
- implying every task invokes a tool;
- implying the agent directly controls the DOM or application database;
- conflating authorization with task execution;
- conflating a successful task with a permanent authorization grant;
- placing Codex, OmniGENT, or another provider in the public application API;
- describing the custom bridge as a stable MCP-over-ACP standard;
- futuristic glowing nodes, glassmorphism, gradients, particle tunnels, or an
  abstract “AI network” aesthetic;
- decorative grid backgrounds or generic automation diagrams;
- bouncing, elastic, excessively slow, or continuously looping motion;
- scraping the existing rendered activity-feed text instead of subscribing to
  typed events;
- a desktop-only composition;
- hiding essential meaning from reduced-motion users.

## Public-demo disclosure

The public judge runtime is deterministic. It selects and replays
Codex-authored tool plans while still exercising the real gateway, OmniGENT,
ACP, request-scoped MCP, SDK, and browser-tool path. Do not label the public
fixture as live Codex reasoning.

The same browser-to-tool path has separately been exercised with real Codex
through OmniGENT. A real coding-agent connection reasons over the same
application tool definitions.

The visualization should represent the generic runtime role as “Coding agent”
or use the runtime name received from the event. It must not hard-code the
deterministic public fixture as Codex.

## Desired outcome

The visitor should understand, without reading the implementation, that:

1. a developer can add agent-powered features by defining normal app-native
   tools;
2. the user connects an agent they own rather than receiving a vendor-owned
   embedded chatbot;
3. Agent Connect supplies the secure, revocable bridge between the two;
4. the application retains authority over what actions actually execute;
5. the relationship is a dynamic, bidirectional conversation rather than a
   prompt moving through a fixed pipeline.
