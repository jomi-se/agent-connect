# 0008: Separate the Agent Connect control plane from runtime confinement

- Status: accepted target direction; current implementation is transitional
- Date: 2026-07-14

## Context

Enrollment, connector identity, application authorization, scoped prompt and
tool access, approval routing, normalized events, action recovery, and audit are
largely independent of the selected agent harness. Filesystem isolation,
network policy, credential placement, workspace persistence, and sandbox
lifecycle depend heavily on the runtime and deployment environment.

Treating all of those concerns as one OmniGENT-specific connector would make
the application SDK unnecessarily proprietary. Requiring every agent or app
developer to implement the whole security system would make simple use cases,
such as adding an item to a shopping list, unreasonably difficult.

At the same time, sandboxing cannot simply be declared a user concern. An
application needs to know which authority it is requesting, and an application
grant must never let the application weaken the runtime's existing policy.

## Decision

Agent Connect is the harness-neutral trust and application-capability control
plane. Runtime adapters own agent execution and confinement mechanics.

### Agent Connect owns

- connector identity, enrollment, key continuity, and transport profiles;
- connector-hosted OAuth application authorization and revocation;
- origin-, app-key-, scope-, and tool-snapshot-bound grants;
- the public task, stream, application-tool, cancellation, and recovery API;
- separation of application-tool results from connector/runtime approvals;
- opaque logical sessions and durable unresolved application actions;
- connector-level concurrency, request, time, and abuse ceilings;
- a provider-neutral vocabulary for requested, configured, and observed runtime
  posture;
- preventing an application request from broadening the selected runtime
  policy.

These capabilities are reusable across OmniGENT, OpenClaw, direct Codex
app-server, ACP, AG-UI, or another runtime adapter.

### The runtime adapter owns

- selecting and launching the agent harness and model;
- model authentication and provider-specific session lifecycle;
- filesystem mounts, scratch workspaces, persistence, and teardown;
- shell, process, network, and environment isolation;
- runtime-native tools, MCP servers, plugins, skills, and credentials;
- native permission enforcement and sandbox-specific approval semantics;
- translating the runtime's events into Agent Connect's internal provider
  contract.

The reference connector may configure and validate recommended runtime profiles,
but the public SDK does not prescribe Bubblewrap, containers, micro-VMs,
OmniGENT managed hosts, or any other sandbox implementation.

### Responsibility is separate from assurance

Sandbox implementation is outside the Agent Connect protocol boundary, but
runtime posture remains visible to authorization and policy:

- the application may request a named posture such as `application-tools-only`
  or `ephemeral-capable`;
- the connector selects an equal or stricter locally configured profile;
- the runtime adapter reports configured properties and separately reports
  observations that support or contradict them;
- the connector labels the source honestly as connector-configured,
  runtime-reported, externally attested, or observed by a named probe;
- an application may require a named posture or evidence source, but the
  connector must reject the session when it cannot substantiate that request;
  it must not promote a self-report into proof;
- an application cannot request a weaker sandbox, new host mount, broader
  network, ambient integration, or local approval authority.

Agent Connect does not claim to remotely prove arbitrary self-hosted sandbox
enforcement without an independent attestation source. Connector identity proves
which connector answered, not that all of its runtime claims are true.

A connector that launches Codex directly as its own VM user has no independent
confinement boundary to report. It may observe Codex's command line, configured
approval mode, child processes, or successful and failed canary probes, but the
same-user process may still inherit host filesystem, credential, process, and
network authority. That deployment must be described as direct/ambient host
execution, not `application-tools-only`. A signature by the connector proves
who made that statement, not that the statement is true.

Runtime probes are useful regression tests for a trusted installation. They do
not prove the absence of another escape path, defend against a compromised
connector or host, or create remote attestation. Stronger evidence requires an
independent enforcement boundary and, if a remote application needs to verify
it cryptographically, an attestation system rooted outside the connector.

### Approval boundary

An application may confirm an operation performed by its own tool. It cannot
answer a runtime request for filesystem, shell, network, MCP, plugin, policy, or
credential authority.

A runtime adapter may surface such a request through a connector-owned page,
but the request uses a separate event type, credential, state machine, and audit
record. The runtime remains the enforcement point. For restrictive profiles,
the configured response may be an automatic denial instead of prompting the
user.

## Reference implementation

The first connector uses OmniGENT for conversation state, harness lifecycle,
policy, and the Codex ACP bridge. OmniGENT is therefore an important
implementation dependency, not part of the application-facing product model.
Its Omnibox or managed-host configuration is one way for the reference
connector to satisfy a runtime posture.

The browser-safe `AgentSession`, `AgentConnection`, application-tool, and task
event types are the intended neutral surface. Current exports named
`OmnigentProvider`, `connectOmnigent`, and `OmnigentProviderOptions` expose the
original spike adapter from the same package. They are transitional and must
not become the default integration path. A later packaging pass should move
provider adapters behind an internal or explicitly experimental entry point
after the neutral `connectAgent` path covers the demonstrated behavior.

The current normalized provider event contract is intentionally small:

```text
stream task with fixed application tools
submit a correlated application-tool result
cancel
emit text, application-tool request, completion, failure, or cancellation
```

A new harness integration should normally implement this narrow adapter, not
the enrollment and OAuth system. Only an implementation replacing the Agent
Connect connector itself needs to implement the full connector trust contract.

## Consequences

- A shopping-list developer uses the web SDK and defines application tools;
  they do not configure OmniGENT or a sandbox.
- A user installs the reference connector once and selects one of its supported
  agents and runtime profiles.
- Supporting another harness is substantially smaller than implementing a new
  connector.
- The reference connector can make secure deployment and policy approachable
  without turning OmniGENT wire shapes into the public standard.
- Runtime-specific confinement remains testable through adapter integration and
  real enforcement probes, but those probes are regression evidence rather
  than general proof of confinement.
- Applications must not interpret a generic `sandboxed: true` claim as strong
  evidence; posture and evidence are structured and explicit.
