# Agent Connect — Implementation Brief

**Status:** implementation handoff / north-star reduction  
**Date:** 2026-09-06  
**Audience:** builder implementing the next Agent Connect prototype

---

## 1. Executive summary

Agent Connect should be implemented as a **client-side “Connect your AI” layer** for web applications.

The application should not own an AI backend, an agent runtime, a model protocol, a session gateway, or a subscription credential. Instead:

1. The **browser application** lets the user connect an AI provider/runtime.
2. Agent Connect obtains or accepts an appropriate credential:
   - preferably a **delegated, scoped credential** from an Agent Connect-native provider;
   - otherwise an existing provider-specific OAuth/API-key flow;
   - as a compatibility fallback, a manually supplied BYOK credential.
3. Agent Connect turns that connection into a **Vercel AI SDK `LanguageModel`** using existing AI SDK provider adapters.
4. The browser discovers application tools from **WebMCP**.
5. Those WebMCP tools are adapted to AI SDK tools.
6. AI SDK runs the model/tool loop **in the browser**.
7. For an Agent Connect-native provider such as OpenClaw, the remote provider exposes an **Open Responses endpoint**, validates the delegated Agent Connect credential, owns the user’s upstream model/subscription authentication, and returns client-side function calls when needed.
8. WebMCP tool calls execute in the browser, and their results are sent back to the remote provider through the next Open Responses step.

The intended architecture is therefore:

```text
                    Browser / application
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  App UI                                                      │
│    │                                                         │
│    ├── "Connect your AI" UI                                  │
│    │       │                                                 │
│    │       └── Agent Connect / OAuth / BYOK connector        │
│    │                                                         │
│    ├── Vercel AI SDK                                         │
│    │       │                                                 │
│    │       └── LanguageModel                                 │
│    │                                                         │
│    └── WebMCP                                                │
│            │                                                 │
│            └── app-defined browser tools                     │
│                                                              │
└───────────────────────────┬──────────────────────────────────┘
                            │
                            │ HTTPS / provider protocol
                            │
                            ▼
                 User-chosen AI provider/runtime
                 ┌─────────────────────────────┐
                 │ OpenClaw                    │
                 │ OpenRouter                  │
                 │ OpenAI API                  │
                 │ Anthropic API               │
                 │ Ollama / local runtime      │
                 │ other AI SDK provider       │
                 └─────────────────────────────┘
```

For the **native Agent Connect path**, the provider-facing execution protocol is Open Responses:

```text
Browser
  │
  │ POST /v1/responses
  │ Authorization: Bearer <delegated Agent Connect token>
  ▼
OpenClaw / Agent Connect-native provider
  │
  │ model decides to call an application tool
  ▼
function_call
  │
  ▼
Browser
  │
  │ document.modelContext.executeTool(...)
  ▼
WebMCP tool
  │
  │ result
  ▼
Browser
  │
  │ next Open Responses step / function_call_output
  ▼
OpenClaw
```

This is intentionally small.

**Do not rebuild functionality already provided by AI SDK, Open Responses, OAuth, or WebMCP.**

---

# 2. The product idea in one sentence

> **Agent Connect lets a web application use the user’s chosen AI, directly from the browser, regardless of whether the connection is a native delegated Agent Connect grant, an existing OAuth/API-key flow, or a BYOK compatibility adapter.**

The long-term ideal is a provider-native delegated connection:

```text
Connect OpenClaw
    ↓
provider authorization UI
    ↓
approve constrained application grant
    ↓
browser receives scoped access token
    ↓
AI SDK talks directly to Open Responses
```

But the SDK should be useful **before an Agent Connect ecosystem exists** by also supporting existing provider connections:

```text
Connect your AI
    │
    ├── OpenClaw       → Agent Connect delegated OAuth
    ├── OpenRouter     → existing PKCE → user-controlled API key
    ├── OpenAI         → manual API key, where browser usage is supported
    ├── Anthropic      → manual API key, where browser usage is supported
    ├── Google         → provider-specific BYOK
    ├── Mistral        → provider-specific BYOK
    ├── xAI            → provider-specific BYOK
    ├── Ollama         → local endpoint
    ├── Open Responses → arbitrary compatible endpoint + credential
    └── OpenAI-compatible endpoint → base URL + credential
```

The application consumes all of them through the same AI SDK model interface.

---

# 3. Core architectural decision: Agent Connect is client-side

“Client-side” here means **the application-side Agent Connect runtime and orchestration execute in the browser**.

It does **not** mean the model executes locally.

The normal topology is:

```text
browser application
       │
       │ direct HTTPS
       ▼
user's AI provider/runtime
       │
       │ provider-owned upstream authentication
       ▼
model/subscription/provider
```

For OpenClaw:

```text
Bookhand browser
      │
      │ Agent Connect delegated token
      ▼
user's OpenClaw
      │
      │ OpenClaw's own OpenAI/Claude/etc. credentials
      ▼
upstream model provider
```

The application must never need the upstream subscription/session credential held by OpenClaw.

The browser only sees a credential intentionally issued to **this application**.

This creates the desired trust boundary:

```text
APPLICATION TRUST DOMAIN               USER AI TRUST DOMAIN

Bookhand JS
    │
    │ ac_<scoped delegated credential>
    ├──────────────────────────────────────► OpenClaw
    │                                          │
    │                                          │ upstream subscription/API auth
    │                                          ▼
    │                                      OpenAI/Claude/etc.
    │
    └── never receives upstream credential
```

A third-party application backend is not required for the native Agent Connect flow.

In fact, adding one as a credential proxy should be considered an architectural regression unless there is a very strong reason for it.

---

# 4. Responsibilities by layer

## 4.1 Agent Connect owns

Agent Connect should own only the connection layer and thin integration glue:

- provider/connection discovery;
- connection chooser UI;
- auth-flow selection;
- PKCE handling;
- Agent Connect delegated authorization;
- compatibility BYOK flows;
- token/key lifecycle on the client;
- connection metadata;
- turning a connection into an AI SDK model;
- a small WebMCP → AI SDK adapter;
- connection status / disconnect / reconnect UX;
- provider capability metadata needed by the UI;
- browser-compatibility checks;
- documentation and sample provider setup.

Agent Connect should **not** own an independent model abstraction.

The returned runtime model should be an AI SDK `LanguageModel`.

---

## 4.2 Vercel AI SDK owns

Use AI SDK for:

- provider abstraction;
- `LanguageModel`;
- streaming;
- messages;
- tool schemas;
- tool calling;
- multi-step model/tool loops;
- stop conditions;
- provider adapters;
- Open Responses adaptation;
- OpenAI/Anthropic/etc. provider implementations where appropriate.

Relevant package for Agent Connect-native providers:

```text
@ai-sdk/open-responses
```

It currently supports:

```ts
createOpenResponses({
  name,
  url, // complete POST endpoint
  apiKey, // sent as Authorization bearer token
  headers,
  fetch,
});
```

That is almost exactly the native Agent Connect execution adapter we need.

---

## 4.3 WebMCP owns

WebMCP defines the browser application’s tools.

The current draft API exposes:

```ts
document.modelContext.getTools();
document.modelContext.executeTool(tool, input);
document.modelContext.ontoolchange;
```

Each registered tool has, among other fields:

```ts
{
  (name, title, description, inputSchema, origin, annotations);
}
```

The WebMCP spec is still moving. Keep all direct WebMCP API interaction behind a tiny adapter package so changes do not leak across Agent Connect.

---

## 4.4 Agent Connect-native provider owns

An Agent Connect-native provider such as OpenClaw owns:

- authorization-server behavior;
- grant approval UI;
- grant persistence;
- access-token issuance;
- refresh/revocation;
- authorization enforcement;
- application-specific resource/conversation isolation;
- provider/native capability policy;
- the Open Responses endpoint;
- model/runtime execution;
- upstream model/subscription credentials;
- any provider-native tools the grant permits.

The application should not know how the provider implements the grant internally.

The access token may be opaque.

---

# 5. The two classes of connection

This distinction should be explicit in the implementation.

## 5.1 Native Agent Connect connection

A native provider implements the Agent Connect authorization profile and exposes an Open Responses resource.

Example:

```text
OpenClaw
```

Flow:

```text
user chooses OpenClaw
       ↓
browser discovers provider metadata
       ↓
browser starts Authorization Code + PKCE
       ↓
provider shows Agent Connect grant consent
       ↓
user approves
       ↓
browser receives access token
       ↓
@ai-sdk/open-responses
       ↓
direct browser → OpenClaw execution
```

This is the preferred connection type.

Benefits:

- app-specific credential;
- limited authority;
- revocable;
- renewable;
- no upstream/master credential exposed;
- provider can enforce app-owned conversation/resource boundaries;
- provider can separately approve native capabilities;
- cleaner UX;
- potentially subscription-backed without the app handling subscription credentials.

---

## 5.2 Compatibility connection

Compatibility connectors let the SDK support existing providers that do not implement Agent Connect.

Examples:

### Existing OAuth/key-generation flow

OpenRouter already exposes a browser-friendly PKCE flow that ends in a user-controlled API key.

```text
OpenRouter login
      ↓
PKCE authorization
      ↓
authorization code
      ↓
browser exchanges code
      ↓
user-controlled OpenRouter API key
      ↓
AI SDK OpenRouter/OpenAI-compatible adapter
```

### Manual BYOK

For providers with ordinary API keys:

```text
Connect OpenAI
      ↓
paste API key
      ↓
validate
      ↓
instantiate @ai-sdk/openai
```

or:

```text
Connect Anthropic
      ↓
paste API key
      ↓
validate
      ↓
instantiate @ai-sdk/anthropic
```

### Generic endpoint

```text
Open Responses endpoint
[ https://host.example/v1/responses ]

Bearer credential
[ __________________________ ]

Model
[ __________________________ ]
```

Use:

```ts
createOpenResponses({
  name,
  url,
  apiKey,
});
```

### Local provider

Example Ollama-compatible connector:

```text
http://localhost:11434
```

No Agent Connect protocol is required.

---

# 6. Important distinction: auth connector != model provider

Do **not** recreate Vercel’s provider registry.

Agent Connect connectors answer:

> How does the user establish a usable connection?

AI SDK providers answer:

> How do we speak to the resulting model service?

These are different concepts.

For example:

```text
Agent Connect connector            AI SDK execution adapter
───────────────────────            ──────────────────────────

OpenClaw OAuth                →     @ai-sdk/open-responses
OpenRouter PKCE              →     OpenRouter/OpenAI-compatible provider
OpenAI pasted key            →     @ai-sdk/openai
Anthropic pasted key         →     @ai-sdk/anthropic
Mistral pasted key           →     @ai-sdk/mistral
generic Open Responses       →     @ai-sdk/open-responses
generic OpenAI-compatible    →     OpenAI-compatible provider
Ollama localhost             →     community Ollama provider
```

The same execution adapter may be used by multiple auth connectors.

Keep these layers separate.

---

# 7. Proposed package structure

Do not over-package the first prototype. It is reasonable to implement this initially in one package with internal modules, then split once the API is stable.

The eventual conceptual package boundaries are:

```text
@agent-connect/core
@agent-connect/react
@agent-connect/ai-sdk
@agent-connect/webmcp
```

## `@agent-connect/core`

Owns:

- connector interfaces;
- serializable connection records;
- auth state;
- PKCE helpers;
- storage interface;
- discovery;
- lifecycle;
- connection registry.

No React dependency.

---

## `@agent-connect/react`

Owns:

- `<ConnectAI />`;
- provider chooser;
- connection modal;
- key-entry forms;
- OAuth redirect state;
- status UI;
- `AIConnectionProvider`;
- `useAIConnection()`;
- reconnect/disconnect UI.

---

## `@agent-connect/ai-sdk`

Owns:

- `ConnectionRecord` → AI SDK `LanguageModel`;
- Open Responses adapter;
- provider-specific AI SDK adapter bindings;
- optional model selection helpers.

This package should remain thin.

---

## `@agent-connect/webmcp`

Owns:

- WebMCP feature detection;
- `getTools`;
- WebMCP → AI SDK tool conversion;
- WebMCP execution;
- tool-change handling;
- WebMCP annotations / local execution policy.

This package isolates us from WebMCP draft churn.

---

# 8. Suggested core data model

The following is illustrative, not a required public API.

Prefer serializable connection records.

```ts
type ConnectionAuthKind =
  "agent-connect" | "oauth-key" | "api-key" | "endpoint-token" | "local";

type ExecutionAdapter =
  | {
      type: "open-responses";
      endpoint: string;
      providerName: string;
    }
  | {
      type: "ai-sdk-provider";
      provider: string;
      baseURL?: string;
    }
  | {
      type: "openai-compatible";
      baseURL: string;
      providerName: string;
    };

interface AIConnectionRecord {
  id: string;

  connectorId: string;
  displayName: string;

  authKind: ConnectionAuthKind;

  execution: ExecutionAdapter;

  // Provider-selected or user-selected default.
  defaultModel?: string;

  // Secret MUST NOT be logged or serialized into analytics.
  credential?: string;

  refreshToken?: string;
  expiresAt?: number;

  metadata?: Record<string, unknown>;
}
```

Do not put executable functions in the persisted record.

Runtime adapters can convert a record into a model:

```ts
function createLanguageModel(
  connection: AIConnectionRecord,
  modelId?: string,
): LanguageModel;
```

---

# 9. Suggested connector interface

Illustrative API:

```ts
interface AIConnector {
  id: string;
  displayName: string;

  authKind: ConnectionAuthKind;

  /**
   * Whether this connector is expected to support direct browser execution.
   * This is NOT equivalent to whether a provider has an HTTP API.
   */
  browserDirect: boolean;

  /**
   * Native Agent Connect connections should return true.
   */
  delegatedCredential: boolean;

  /**
   * Establish the connection.
   */
  connect(ctx: ConnectContext): Promise<AIConnectionRecord>;

  /**
   * Refresh or repair the connection if supported.
   */
  refresh?(
    connection: AIConnectionRecord,
    ctx: ConnectContext,
  ): Promise<AIConnectionRecord>;

  /**
   * Provider-specific remote revocation if supported.
   */
  revoke?(connection: AIConnectionRecord, ctx: ConnectContext): Promise<void>;
}
```

The connector should not implement inference.

Inference is created separately from `AIConnectionRecord`.

---

# 10. Native Agent Connect authorization shape

The preferred flow should resemble normal OAuth resource authorization, not a custom session protocol.

Conceptually:

```text
                    AUTHORIZATION

Browser                                         OpenClaw
   │                                               │
   │ discover provider/resource metadata           │
   ├──────────────────────────────────────────────►│
   │                                               │
   │ authorization request + PKCE                  │
   ├──────────────────────────────────────────────►│
   │                                               │
   │            provider consent UI                │
   │                                               │
   │◄──────────── authorization code ──────────────┤
   │                                               │
   │ exchange code + verifier                      │
   ├──────────────────────────────────────────────►│
   │                                               │
   │◄──────── access token / refresh token ────────┤
```

After that:

```text
                      EXECUTION

Browser                                         OpenClaw
   │                                               │
   │ POST /v1/responses                            │
   │ Authorization: Bearer ac_xxx                  │
   ├──────────────────────────────────────────────►│
   │                                               │
   │◄──────── Open Responses stream ───────────────┤
```

**Do not place the grant object into every `/v1/responses` request.**

The bearer credential represents the authorization.

The provider resolves/enforces it.

For example, internally OpenClaw might store:

```ts
Grant {
  resourceOwner: 'user-123',
  client: 'https://bookhand.example/client-metadata.json',

  permissions: {
    responses: 'create',
    conversations: 'application-owned',
  },

  providerCapabilities: [
    'web-search',
  ],

  privateResources: [],

  expiresAt: ...
}
```

The application does not need to understand this representation.

---

# 11. Grant granularity: connection, not model turn

The native authorization grant should normally represent:

```text
application installation/user
        ×
AI provider
```

not:

```text
one token per /v1/responses call
```

and not necessarily:

```text
one token per conversation
```

A connection may own many conversations:

```text
Jomi
└── Bookhand grant on OpenClaw
    ├── conversation 1
    ├── conversation 2
    └── conversation 3
```

The provider must ensure Bookhand cannot cross into conversations/resources owned by unrelated applications or the user’s ambient personal-agent context unless separately authorized.

---

# 12. Application-owned authority is the key security semantic

A native Agent Connect token is not merely:

> “this user exists.”

It should represent an **application execution security context**.

Example:

```text
Bookhand grant

allowed:
  ✓ create AI responses
  ✓ continue Bookhand-owned conversations
  ✓ use Bookhand-provided WebMCP tools
  ✓ use provider-native web search

not allowed:
  ✗ access unrelated personal conversations
  ✗ access Gmail
  ✗ access Google Drive
  ✗ access personal memory
  ✗ invoke arbitrary OpenClaw admin APIs
```

This avoids accidental ambient-authority leakage.

If OpenClaw itself has powerful personal tools, those tools must not automatically become available to every connected web application merely because the user previously enabled them in OpenClaw.

---

# 13. Do not standardize “allowance” too early

The first implementation should avoid inventing a universal billing abstraction.

Different providers may measure capacity in:

- tokens;
- money;
- messages;
- rolling subscription windows;
- compute time;
- local compute;
- provider-specific quotas.

The baseline semantic can be:

> The application may consume the user’s AI resources subject to provider-enforced policy and limits.

Provider-specific or future Agent Connect extensions may support explicit budgets.

Do not block the MVP on a universal `allowance` schema.

---

# 14. AI SDK integration

## 14.1 Native Open Responses provider

For a native Agent Connect connection:

```ts
import { createOpenResponses } from "@ai-sdk/open-responses";

function createAgentConnectModel(
  connection: AIConnectionRecord,
  modelId: string,
) {
  const provider = createOpenResponses({
    name: connection.execution.providerName,
    url: connection.execution.endpoint,
    apiKey: connection.credential,
  });

  return provider(modelId);
}
```

No Agent Connect-specific header is needed beyond the bearer credential unless a concrete interoperability requirement is discovered later.

---

## 14.2 Existing AI SDK providers

For BYOK connectors, instantiate the existing AI SDK provider.

Conceptually:

```ts
switch (connection.execution.provider) {
  case "openai":
    return createOpenAI({
      apiKey: connection.credential,
    })(modelId);

  case "anthropic":
    return createAnthropic({
      apiKey: connection.credential,
    })(modelId);

  // etc.
}
```

Prefer existing AI SDK adapters.

Do not implement provider wire protocols inside Agent Connect.

---

# 15. Browser compatibility must be first-class

Not every API provider permits direct browser access.

A provider having an API key and an AI SDK adapter does **not** imply it is suitable for a client-only Agent Connect application.

A connector should only be exposed as supported when the required endpoint can actually be called directly from the browser, including:

- CORS;
- browser-compatible authentication;
- provider policy/SDK behavior;
- no required confidential client secret.

If a provider requires a trusted backend for ordinary API usage, **do not add an Agent Connect-hosted proxy merely to force compatibility**.

That would destroy the architecture.

Instead:

```text
provider unsupported for browser-direct BYOK
        ↓
not offered as a direct compatibility connector
```

or recommend:

```text
user-owned OpenClaw/local gateway
        ↓
Agent Connect native delegated connection
        ↓
provider accessed from user's runtime
```

The compatibility matrix should therefore track:

```ts
interface ConnectorCapabilities {
  browserDirect: boolean;
  cors: "yes" | "no" | "conditional" | "unknown";
  credentialKind:
    "delegated" | "user-controlled-key" | "master-api-key" | "none";
}
```

---

# 16. Credential hierarchy and UX

The UI should distinguish connection quality.

Suggested ordering:

```text
PREFERRED
────────────────────────────────────────

1. Agent Connect delegated connection
   - app-specific
   - scoped
   - revocable
   - upstream/master credential not exposed

2. Provider-native OAuth / generated key
   - e.g. OpenRouter PKCE
   - often app-specific/user-controlled

3. Manual BYOK
   - user pastes ordinary provider API key
   - JavaScript can necessarily access it

4. Generic endpoint + key
   - maximum compatibility
   - least provider-specific safety/UX

────────────────────────────────────────
FALLBACK
```

Possible UI:

```text
Choose your AI

OpenClaw
Secure delegated connection
[ Connect ]

OpenRouter
One-click account connection
[ Connect ]

OpenAI API
Requires an API key
[ Add key ]

Other Open Responses provider
Connect an endpoint
[ Configure ]
```

Do not falsely present raw BYOK as equivalent to a scoped delegated credential.

---

# 17. OpenRouter should be an early compatibility connector

OpenRouter is a strong proof that “connect account → receive usable API credential” already exists.

Its documented PKCE flow is:

```text
browser
  ↓
https://openrouter.ai/auth
  ↓
user authorizes
  ↓
redirect with authorization code
  ↓
POST /api/v1/auth/keys
  ↓
user-controlled API key
```

The flow supports PKCE and the generated key can be associated with expiry/credit-limit behavior.

This makes OpenRouter an excellent second connection type after OpenClaw because:

- UX resembles Agent Connect;
- implementation is independent;
- no manual copy/paste;
- it validates the generic connector abstraction;
- it demonstrates that the SDK is useful beyond Agent Connect-native providers.

---

# 18. WebMCP → AI SDK adapter

This should be extremely thin.

Current WebMCP exposes:

```ts
const tools = await document.modelContext.getTools();
```

Each tool already contains almost exactly the data AI SDK needs:

```text
WebMCP                        AI SDK tool
──────                        ───────────

name                          ToolSet object key
description                   description
inputSchema                   inputSchema
executeTool(...)              execute(...)
```

Illustrative conversion:

```ts
import { dynamicTool, jsonSchema } from "ai";

async function getWebMCPTools() {
  const webTools = await document.modelContext.getTools();

  return Object.fromEntries(
    webTools.map((webTool) => [
      webTool.name,

      dynamicTool({
        description: webTool.description,

        inputSchema: jsonSchema(webTool.inputSchema),

        execute: async (input) => {
          const result = await document.modelContext.executeTool(
            webTool,
            input as object,
          );

          // WebMCP currently returns a stringified result.
          // Preserve a string unless safely parseable.
          try {
            return JSON.parse(result);
          } catch {
            return result;
          }
        },
      }),
    ]),
  );
}
```

Verify the exact AI SDK schema wrapper API against the pinned AI SDK version during implementation.

---

# 19. Tool loop

The simplest intended execution path is:

```ts
const connection = await connectAI(...);

const model = createLanguageModel(
  connection,
  selectedModel,
);

const tools = await getWebMCPTools();

const result = streamText({
  model,
  tools,

  messages,

  // Example only. Pick an explicit sensible limit.
  stopWhen: stepCountIs(20),
});
```

AI SDK already supports multi-step tool execution.

The desired control flow is:

```text
1. browser sends model request + WebMCP tool schemas
2. remote provider/model returns function call
3. AI SDK invokes local tool.execute(...)
4. tool.execute calls document.modelContext.executeTool(...)
5. WebMCP executes application code in the browser
6. AI SDK adds tool result
7. AI SDK sends next model step
8. repeat until text/final result or stop condition
```

This is the original Agent Connect remote-tool loop, but composed from existing primitives.

Do not rebuild it.

---

# 20. Tool changes

Web pages may register/unregister/change WebMCP tools dynamically.

Use WebMCP’s tool-change event to refresh the available tool set.

Suggested rule:

- snapshot tools for an active generation/tool chain;
- when `toolchange` fires, refresh for the next top-level generation;
- avoid mutating the tool contract in the middle of an active model step unless AI SDK behavior is explicitly designed for it.

This avoids races between:

```text
model saw schema A
```

and:

```text
browser now exposes schema B
```

---

# 21. WebMCP annotations must not be silently lost

Current WebMCP includes tool annotations such as:

```ts
{
  readOnlyHint,
  untrustedContentHint,
  consequentialHint,
}
```

The adapter must retain these locally even if AI SDK/Open Responses cannot transmit them as first-class model tool metadata.

At minimum they should be available for:

- local policy;
- UI;
- tool approval;
- logging/auditing that does not contain secrets;
- consequential-action confirmation if the app chooses to require it.

Do not encode these semantics by concatenating secret policy text into tool descriptions.

Treat this as an adapter-design item worth explicit tests.

---

# 22. React API shape

A plausible developer-facing experience:

```tsx
import { AIConnectionProvider, ConnectAI } from "@agent-connect/react";

function App() {
  return (
    <AIConnectionProvider
      connectors={[
        openClawConnector(),
        openRouterConnector(),
        genericOpenResponsesConnector(),
      ]}
    >
      <Bookhand />
      <ConnectAI />
    </AIConnectionProvider>
  );
}
```

Then:

```tsx
function BookhandAssistant() {
  const { connection, model, disconnect } = useAIConnection();

  // Application code should not care whether this came from
  // OpenClaw OAuth, OpenRouter PKCE, or BYOK.

  // ...
}
```

Do not freeze this exact React API before the proof-of-concept works.

The important property is:

> consuming application code sees a connected AI model, not provider-auth details.

---

# 23. Minimal imperative API

The non-React path should stay equally straightforward:

```ts
const connection = await connectAI({
  connector: openClawConnector({
    url: "https://my-openclaw.example",
  }),
});

const model = createLanguageModel(
  connection,
  connection.defaultModel ?? "default",
);

const tools = await createWebMCPToolSet();

const result = streamText({
  model,
  tools,
  prompt: "...",
  stopWhen: stepCountIs(20),
});
```

The implementation may end up with slightly different naming.

Preserve the conceptual simplicity.

---

# 24. Provider discovery for the native Agent Connect path

Do not over-design discovery for the first working implementation.

For the prototype, accepting:

```text
https://my-openclaw.example
```

and deriving/discovering:

```text
authorization server
Open Responses endpoint
provider display metadata
```

is sufficient.

Longer term, Agent Connect should compose existing OAuth discovery mechanisms rather than inventing a registry.

Likely relevant mechanisms include:

- OAuth Authorization Server Metadata;
- OAuth Protected Resource Metadata;
- Resource Indicators;
- Client ID Metadata Documents for previously unknown public clients;
- Rich Authorization Requests for structured AI grants.

The exact profile should be specified only after the second independent native provider exposes what must actually interoperate.

---

# 25. Client identity

A self-hosted provider cannot reasonably require every web application to preregister a client secret.

Agent Connect should treat a web application as a **public OAuth client**.

Use:

```text
Authorization Code + PKCE
```

not a confidential client secret embedded in JavaScript.

Client ID Metadata Documents are a promising mechanism for allowing a provider to identify an application it has never seen before.

For the hackathon prototype, use the smallest flow compatible with the existing OpenClaw work, but keep the design aligned with public-client semantics.

---

# 26. Storage policy

Browser credentials are JavaScript-accessible by definition.

There is no magic browser storage mechanism that makes a raw API key inaccessible to same-origin application code.

Therefore:

## Native delegated credentials

These are the preferred credential because compromise has bounded authority.

Suggested default:

- keep access token in memory if feasible;
- support refresh;
- persist only if required for acceptable UX;
- make storage implementation pluggable;
- never log token values.

## Raw BYOK credentials

Treat them as a compatibility fallback.

Suggested default:

- explain that the key is available to the application;
- prefer session-scoped/in-memory storage;
- make long-term persistence explicit;
- never send the key to Agent Connect analytics or an Agent Connect backend;
- never put it into URLs;
- never log it.

The SDK should support a storage abstraction such as:

```ts
interface CredentialStore {
  get(connectionId: string): Promise<StoredCredential | undefined>;
  set(connectionId: string, credential: StoredCredential): Promise<void>;
  delete(connectionId: string): Promise<void>;
}
```

Ship conservative defaults.

---

# 27. CORS and direct HTTP are provider requirements

Because the app-side runtime is browser-only:

```text
browser → provider
```

the provider must intentionally support that usage.

A native Agent Connect provider should therefore support:

- HTTPS;
- browser-originated requests;
- CORS;
- `Authorization` request header;
- streaming responses;
- preflight behavior;
- PKCE callback flow;
- token refresh where applicable.

For OpenClaw, document the reference configuration clearly.

Do not solve provider CORS deficiencies with a hosted Agent Connect relay.

---

# 28. Model selection

Avoid turning Agent Connect into a model catalog.

For the MVP:

- a connector may expose a configured `defaultModel`;
- a connector may optionally list available models;
- the application may allow the user to select a model;
- native providers may map a stable local model name to their own upstream provider/model selection.

Do not require applications to understand whether OpenClaw ultimately uses OpenAI, Claude, a local model, or a routed combination.

A good native-provider default is:

```text
application asks for provider's default/agent model
```

unless the product explicitly needs model choice.

---

# 29. Error model

Normalize only errors useful to connection UX.

Possible connection-level errors:

```ts
type ConnectionErrorCode =
  | "authorization_denied"
  | "authorization_expired"
  | "invalid_credential"
  | "credential_expired"
  | "refresh_failed"
  | "provider_unreachable"
  | "browser_not_supported"
  | "cors_blocked"
  | "unsupported_provider"
  | "configuration_error";
```

Do not normalize every inference/provider error prematurely.

AI SDK already has provider/model error machinery.

Preserve raw causes where useful.

---

# 30. Disconnect semantics

`disconnect()` should mean:

1. remove locally persisted credential;
2. clear active runtime state;
3. if provider supports remote revocation, revoke the credential/grant;
4. leave unrelated user/provider data untouched.

For a native Agent Connect connection, remote revocation is strongly preferred.

For raw BYOK, local deletion may be all the SDK can do.

Make this difference visible in connector metadata.

---

# 31. Logging / telemetry rules

Never log:

- bearer tokens;
- refresh tokens;
- API keys;
- OAuth codes;
- PKCE verifiers;
- upstream subscription credentials;
- raw WebMCP tool results by default.

Safe-ish metadata can include:

- connector ID;
- auth kind;
- provider type;
- connection success/failure category;
- latency;
- browser compatibility failure;
- anonymized feature usage.

Telemetry should be optional and should not become an accidental credential/data exfiltration channel.

---

# 32. Reference OpenClaw implementation requirements

The example OpenClaw provider should demonstrate the complete native path.

It must:

1. expose an Open Responses endpoint;
2. expose or support the chosen OAuth discovery mechanism;
3. support Authorization Code + PKCE for browser clients;
4. identify the requesting application;
5. show a consent screen;
6. create an app-specific grant;
7. mint an access token representing that grant;
8. validate the token on `/v1/responses`;
9. enforce application resource isolation;
10. ensure non-granted personal/native capabilities are unavailable;
11. keep upstream subscription/API authentication inside OpenClaw;
12. support CORS for the browser app;
13. support token expiry/revocation;
14. return ordinary Open Responses function calls for client-side app tools.

The Open Responses endpoint should not know or care whether the token is:

- opaque;
- JWT;
- backed by DB state;
- introspected through another authorization server.

That is provider implementation detail.

---

# 33. Compatibility provider registry

Maintain a connector registry independent from AI SDK’s provider registry.

Example metadata:

```ts
const connectors = {
  openclaw: {
    auth: "agent-connect",
    delegatedCredential: true,
    browserDirect: true,
    execution: "open-responses",
  },

  openrouter: {
    auth: "oauth-key",
    delegatedCredential: false,
    browserDirect: true,
    execution: "openrouter",
  },

  openai: {
    auth: "api-key",
    delegatedCredential: false,
    browserDirect: "conditional",
    execution: "openai",
  },

  anthropic: {
    auth: "api-key",
    delegatedCredential: false,
    browserDirect: "conditional",
    execution: "anthropic",
  },

  genericOpenResponses: {
    auth: "endpoint-token",
    delegatedCredential: "unknown",
    browserDirect: "conditional",
    execution: "open-responses",
  },
};
```

Do not infer browser support solely from AI SDK package availability.

Test it.

---

# 34. Recommended implementation sequence

## Phase 0 — prove the reduced architecture

Goal:

> One static/browser app, one OpenClaw provider, one WebMCP tool, zero application AI backend.

Implement:

1. configure OpenClaw Open Responses endpoint;
2. obtain a temporary token using the simplest current mechanism;
3. call OpenClaw directly from browser using `@ai-sdk/open-responses`;
4. expose one WebMCP tool;
5. adapt it to an AI SDK tool;
6. use `streamText`;
7. allow at least two model/tool steps;
8. prove WebMCP tool executes in the page;
9. prove result returns to OpenClaw and generation continues.

This is the architectural proof.

Do this before building a beautiful connection UI.

---

## Phase 1 — Agent Connect native connection flow

Implement:

- discovery;
- Authorization Code + PKCE;
- consent;
- access token;
- refresh/revocation;
- connection record;
- `createLanguageModel(connection)`.

Replace the temporary token from Phase 0.

---

## Phase 2 — reusable WebMCP adapter

Extract:

```ts
createWebMCPToolSet();
```

Requirements:

- `getTools()`;
- JSON Schema adaptation;
- execution;
- errors;
- cancellation;
- tool-change handling;
- annotations;
- tests.

---

## Phase 3 — React connection UI

Implement:

```tsx
<ConnectAI />;
useAIConnection();
```

Support at least:

- connect OpenClaw;
- status;
- reconnect;
- disconnect;
- model/default-model information.

---

## Phase 4 — OpenRouter connector

Implement the existing OpenRouter PKCE flow.

Demonstrate that the same application works with:

```text
OpenClaw
```

and:

```text
OpenRouter
```

without changing application AI code.

This validates the auth-connector abstraction.

---

## Phase 5 — generic BYOK

Add only providers proven to work directly in the browser.

Start with:

- generic Open Responses;
- generic OpenAI-compatible endpoint;
- local provider;
- selected direct BYOK providers.

Do not promise every AI SDK provider automatically.

---

## Phase 6 — second independent native Agent Connect provider

This is the actual interoperability test.

Implement a deliberately small provider that does **not** reuse OpenClaw internals.

For example:

```text
tiny-agent-connect-provider
    ↓
simple OAuth/grant store
    ↓
Open Responses
    ↓
API-backed or local model
```

The same application must connect to:

```text
OpenClaw
```

and:

```text
tiny independent provider
```

without provider-specific application code.

Any incompatibility found here should inform the actual Agent Connect profile.

---

# 35. MVP acceptance criteria

The MVP is complete when all of the following work.

## Client-side architecture

- [ ] No application AI backend is required.
- [ ] Browser calls the selected AI provider directly.
- [ ] OpenClaw subscription/upstream credentials never enter application JS.
- [ ] No Agent Connect inference proxy exists.

## Native provider

- [ ] User can connect OpenClaw.
- [ ] Browser receives an app-specific credential.
- [ ] Credential is accepted by OpenClaw `/v1/responses`.
- [ ] Credential cannot access unrelated OpenClaw user resources.
- [ ] Credential can be disconnected/revoked.

## AI SDK

- [ ] Native connection produces an AI SDK `LanguageModel`.
- [ ] `streamText()` works against OpenClaw through `@ai-sdk/open-responses`.
- [ ] Streaming works in the browser.
- [ ] Multi-step tool calls work.

## WebMCP

- [ ] App exposes at least one real WebMCP tool.
- [ ] Agent Connect discovers it.
- [ ] AI SDK sends schema to model.
- [ ] Remote model calls it.
- [ ] Tool executes in browser.
- [ ] Tool result is sent back.
- [ ] Remote model continues and returns final text.

## Compatibility

- [ ] OpenRouter can be connected through its PKCE flow.
- [ ] Same consuming application code works with OpenClaw and OpenRouter.
- [ ] At least one generic endpoint connector exists.

## UX

- [ ] Connection UI distinguishes delegated vs manual-key connection.
- [ ] User can see which provider is active.
- [ ] User can disconnect.
- [ ] Browser-incompatible connectors fail clearly rather than silently proxying.

---

# 36. Non-goals

Do not implement these unless a concrete blocker proves they are necessary.

- custom Agent Connect model wire protocol;
- custom streaming protocol;
- custom function-call format;
- custom message representation;
- custom agent loop;
- application-hosted AI gateway;
- Agent Connect cloud inference proxy;
- provider-neutral model catalog;
- universal AI billing/allowance model;
- custom browser-tool protocol;
- duplicate MCP protocol;
- provider SDK reimplementations;
- provider-specific model wire formats;
- central provider registry required for interoperability;
- central account system required for Agent Connect;
- application possession of OpenClaw’s upstream subscription credential.

---

# 37. Questions the implementation should answer empirically

Do not solve these entirely on paper.

## WebMCP

- Does the pinned browser/polyfill expose the latest `document.modelContext` API?
- Are `inputSchema` objects already directly compatible with AI SDK `jsonSchema()`?
- How should WebMCP annotations map to AI SDK/local approval policy?
- What should happen when tools change mid-generation?
- How should cancellation propagate?

## AI SDK

- Does `@ai-sdk/open-responses` work cleanly in the target browsers with direct `fetch`?
- Does it preserve all Open Responses tool-call semantics needed by OpenClaw?
- Which current AI SDK provider adapters are actually browser-usable?
- What is the cleanest model-selection API for a generic Open Responses provider?

## OpenClaw

- What minimum CORS configuration is needed?
- Can its Open Responses endpoint cleanly use a delegated app credential rather than its normal owner/admin credential?
- What code currently owns conversation/session isolation?
- Which native tools are ambient today and need grant-aware filtering?
- What is the cleanest provider metadata/discovery endpoint for the prototype?

## OAuth

- Which discovery RFCs should the prototype implement immediately?
- Can Client ID Metadata Documents be used cleanly with the current auth stack?
- Is Rich Authorization Requests useful in v0 or should the grant request initially be simpler?
- What refresh/revocation semantics are essential for the first end-to-end demo?

---

# 38. Suggested demo

A compelling demo should make the architecture obvious without explaining internals first.

## Demo application

Use Bookhand or another small web app exposing WebMCP tools such as:

```text
getCurrentBook()
saveAnnotation()
highlightPassage()
```

## Demo path A — OpenClaw

```text
1. open Bookhand
2. click "Connect your AI"
3. choose OpenClaw
4. enter/select personal OpenClaw endpoint
5. provider authorization page appears
6. approve Bookhand
7. ask:
   "Highlight the paragraph where the author defines X"
8. model runs remotely in OpenClaw
9. OpenClaw returns a function call
10. WebMCP executes highlightPassage() in Bookhand
11. result returns to OpenClaw
12. final answer streams into Bookhand
```

Then explicitly show:

```text
Bookhand never received the user's Claude/OpenAI subscription credential.
```

## Demo path B — OpenRouter

Without changing application code:

```text
1. disconnect OpenClaw
2. choose OpenRouter
3. complete OpenRouter PKCE connection
4. choose model
5. repeat same WebMCP action
```

Now the audience can see:

> One app integration. Multiple user-owned AI connections.

That communicates the project more effectively than a protocol diagram alone.

---

# 39. The long-term standards shape

If the implementation proves the abstraction, Agent Connect itself may ultimately be a **small authorization/interoperability profile around existing standards**.

Possible shape:

```text
Agent Connect profile
    │
    ├── OAuth public-client authorization
    ├── PKCE
    ├── protected-resource / auth-server discovery
    ├── client metadata for unfamiliar applications
    ├── app-specific AI grant semantics
    ├── token/resource isolation semantics
    └── Open Responses as execution
```

The important design principle is:

> **After authorization, normal inference should look like ordinary Open Responses with an ordinary bearer credential.**

Agent Connect should not remain visible in every inference payload unless interoperability proves that something additional is genuinely required.

---

# 40. The reduced mental model

The entire project can be understood as five existing layers plus one thin missing layer:

```text
┌──────────────────────────────┐
│ Application                  │
│ Bookhand / arbitrary web app │
└──────────────┬───────────────┘
               │
               │ application capabilities
               ▼
┌──────────────────────────────┐
│ WebMCP                       │
│ browser tool definitions     │
└──────────────┬───────────────┘
               │
               │ adapted ToolSet
               ▼
┌──────────────────────────────┐
│ Vercel AI SDK                │
│ model + streaming + tool loop│
└──────────────┬───────────────┘
               │
               │ LanguageModel
               ▼
┌──────────────────────────────┐
│ Agent Connect                │
│ CONNECT / AUTH LAYER         │
│                              │
│ "How do I get a usable,      │
│ appropriately constrained    │
│ connection to the user's AI?"│
└──────────────┬───────────────┘
               │
               │ bearer/API credential
               ▼
┌──────────────────────────────┐
│ AI provider/runtime          │
│ OpenClaw / OpenRouter / etc. │
└──────────────────────────────┘
```

For native providers, execution is:

```text
AI SDK
   ↓
@ai-sdk/open-responses
   ↓
Open Responses
   ↓
OpenClaw
```

For compatibility providers:

```text
AI SDK
   ↓
existing AI SDK provider adapter
   ↓
provider API
```

The application code should barely notice the difference.

---

# 41. Builder directive

When implementing this, use the following decision rule:

> Before adding a new Agent Connect abstraction, ask whether AI SDK, Open Responses, OAuth, or WebMCP already owns it.

If yes, use the existing abstraction.

The first prototype should feel suspiciously small.

That is the intended result.

The project is no longer:

> “Build a gateway and agent protocol that can interact with a web app.”

It is:

> **“Build the missing client-side connection layer between an application that wants AI and a user who already has AI somewhere.”**

Everything else should compose around that.

---

# 42. External references

These are implementation references, not requirements to duplicate their designs.

## Vercel AI SDK

- AI SDK home / provider abstraction  
  https://ai-sdk.dev/

- Open Responses provider  
  https://ai-sdk.dev/providers/ai-sdk-providers/open-responses

- AI SDK tool calling  
  https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling

- `streamText`  
  https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text

- `stepCountIs`  
  https://ai-sdk.dev/docs/reference/ai-sdk-core/step-count-is

## WebMCP

- Current WebMCP draft  
  https://webmachinelearning.github.io/webmcp/

The current draft exposes `document.modelContext`, including `getTools()`, `executeTool()`, `registerTool()`, and tool-change behavior.

## OpenRouter

- OAuth / PKCE guide  
  https://openrouter.ai/docs/guides/overview/auth/oauth

- Create authorization code  
  https://openrouter.ai/docs/api/api-reference/o-auth/create-auth-keys-code

- Exchange authorization code for API key  
  https://openrouter.ai/docs/api/api-reference/o-auth/exchange-auth-code-for-api-key

## OAuth building blocks worth evaluating

- OAuth 2.0 Authorization Server Metadata — RFC 8414  
  https://www.rfc-editor.org/rfc/rfc8414

- OAuth 2.0 Resource Indicators — RFC 8707  
  https://www.rfc-editor.org/rfc/rfc8707

- OAuth 2.0 Rich Authorization Requests — RFC 9396  
  https://www.rfc-editor.org/rfc/rfc9396

- OAuth 2.0 Token Introspection — RFC 7662  
  https://www.rfc-editor.org/rfc/rfc7662

- OAuth Client ID Metadata Document draft  
  https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/

---

# 43. Final implementation target

The end state for application developers should be approximately this simple:

```tsx
const connection = await connectAI();

const model = createLanguageModel(connection, connection.defaultModel);

const tools = await createWebMCPToolSet();

const result = streamText({
  model,
  tools,
  messages,
  stopWhen: stepCountIs(20),
});
```

And `connectAI()` may have produced the model through any of these paths:

```text
Agent Connect OAuth → OpenClaw → Open Responses
OpenRouter PKCE     → OpenRouter
manual API key      → supported direct provider
local endpoint      → Ollama/local provider
generic endpoint    → Open Responses/OpenAI-compatible API
```

That is the implementation target.

Everything more complicated should need to justify its existence.
