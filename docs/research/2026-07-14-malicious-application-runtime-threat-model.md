# Malicious application to user-owned agent threat model

Date: 2026-07-14

Status: investigation and proposed security target; gateway authentication,
consent, grant binding/revocation, and a strict event-shape allowlist are
implemented, while runtime confinement and resource ceilings remain incomplete.

## Question

Agent Connect deliberately lets an authorized web application send prompts and
session-scoped tools to a user-owned agent. What prevents a malicious,
compromised, or merely over-privileged application from turning that access
into host compromise, secret theft, subscription abuse, cross-application data
access, or misleading actions?

Authentication answers **which application is asking**. It does not make the
application's prompts, tool descriptions, tool results, or frontend code
trustworthy. The gateway must treat even a correctly authenticated and
user-approved application as an adversarial principal operating within a
strict capability ceiling.

## Current implementation assessment

The live proof currently uses:

- OmniGENT 0.5.1 with the generic `acp:codex-acp` harness;
- `@agentclientprotocol/codex-acp` 1.1.2;
- a gateway-provisioned OmniGENT agent bundle with no explicit `os_env`
  sandbox or contextual policies;
- a private `CODEX_HOME` copied from the user's Codex configuration;
- an application capability bound to Origin, app id, session, and tool hash.

This is adequate for a composition proof, not a safe default for arbitrary
applications.

OmniGENT's generic ACP documentation says `sandbox: none` is currently the
default and notes that an ACP agent needing to write its configuration directory
needs that mode. Therefore the `codex-acp` process in the current proof is not
inside OmniGENT's Omnibox OS sandbox.

`codex-acp` independently defaults to its `agent` mode: Codex receives a
workspace-write sandbox, network disabled for sandboxed tool execution, and an
on-request approval policy. This is a useful second layer, but it is not enough
for the Agent Connect boundary:

- a copied Codex configuration can bring ambient MCP servers, plugins, skills,
  and other authority into a remote application session;
- Codex permission requests need a trusted answer surface, which the requesting
  application must not control;
- OmniGENT's OS sandbox does not cover MCP server subprocesses or the OmniGENT
  supervisor;
- the gateway now permits only strict task-message, tool-result, and interrupt
  shapes, but tool-result correlation still awaits persisted pending actions;
- prompt instructions are advisory and cannot replace sandbox or authorization
  enforcement.

Bubblewrap is installed on the current Linux host, so an Omnibox compatibility
spike is possible. Nested OmniGENT and Codex sandbox behavior, Codex auth/config
access, and model connectivity still need to be proven on the live ACP path.

## Assets

The gateway must protect:

- the user's Codex subscription, token budget, rate limits, and availability;
- host files, repositories, credentials, environment variables, sockets, and
  local services;
- gateway identity keys, application grants, and provider credentials;
- preconfigured MCP servers, connected SaaS accounts, and their write powers;
- prompts, results, tool data, and history belonging to other applications;
- the integrity of application mutations and unresolved action records;
- the user's attention and approval decisions;
- the truthfulness of what the gateway says an application or agent did.

## Adversaries and assumptions

Assume any of the following can be hostile:

- a knowingly malicious application origin;
- an approved application later compromised through XSS, dependency takeover,
  or malicious deployment;
- application-supplied prompts, tool names, descriptions, schemas, arguments,
  and tool results;
- external content read by either the app or the agent;
- an agent following prompt injection or making a dangerous mistake;
- a caller bypassing the public SDK and speaking directly to gateway endpoints.

For the first profile, assume the gateway, its host OS, Tailscale, OmniGENT,
Codex, and the model provider are trusted computing-base components. Sandbox
escape, dependency compromise, and malicious model-provider behavior remain
residual supply-chain or platform risks rather than problems application-level
authorization can solve.

## Trust boundaries

```text
untrusted app origin and JavaScript
  -> Agent Connect authentication and authorization gateway
  -> OmniGENT server, policy engine, and supervisor
  -> runner and generic ACP process
  -> codex-acp and Codex app-server
  -> Codex native tools and sandbox
  -> ambient MCP/app/plugin processes

Codex
  -> approved application-tool request
  -> gateway pending-action record
  -> untrusted app tool implementation
  -> untrusted tool result returned to Codex
```

Each arrow is a validation boundary. Application authorization must never be
treated as authority to change the policy of a deeper boundary.

## Primary threats and controls

| Threat                                        | Example                                                                                                 | Required control                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subscription theft or denial of service       | App loops prompts, long turns, or tool calls                                                            | Per-app concurrency, turn, token, time, tool-call, and rate ceilings enforced by the gateway; revoke and kill live work                                             |
| Host data exfiltration                        | Prompt asks Codex to read SSH keys, dotfiles, another repo, or local service data                       | Empty per-app workspace by default; no home mounts; hidden dotfiles; minimal environment; deny local network; gateway-owned explicit mounts only                    |
| Host mutation or command execution            | Prompt asks for shell commands, package installation, persistence, or destructive edits                 | Application-tools-only default; deny permission escalation; no writable host path; separate named profile for explicit workspace access                             |
| Ambient authority abuse                       | Agent calls an inherited Gmail, GitHub, filesystem, browser, or cloud MCP tool                          | Build a minimal provider home; disable inherited MCP/apps/plugins/skills; allowlist gateway-owned integrations individually                                         |
| Approval laundering                           | Malicious app submits or forges an approval response for a local shell, network, MCP, or policy request | Separate approval protocol and credential; only a top-level gateway-owned UI authenticated as the user may answer; app session API must reject approval event types |
| Cross-app data leakage                        | Provider session, transcript, cache, workspace, or pending action is reused across origins              | Separate downstream session and scratch state per app grant/tool snapshot; origin-bound storage; never expose provider ids; deletion and expiry                     |
| Tool-authority deception                      | App gives an innocuous declaration a dangerous implementation or changes metadata after consent         | Hash and display names/descriptions/schemas; re-consent on metadata drift; state clearly that app-side handler behavior is not attested; app remains untrusted      |
| Tool-result prompt injection                  | Tool returns instructions to reveal secrets or use local powers                                         | Treat result as untrusted data; local capability ceiling remains unchanged; provenance labels where supported; never rely on the model to ignore injection          |
| Protocol event injection                      | Caller bypasses SDK and posts interrupt, output, approval, or future OmniGENT event shapes              | Explicit gateway event allowlist and schema; state-machine validation; bind result to an unresolved action id/name/tool hash; reject everything else                |
| Result spoofing or replay                     | App invents another call id, races duplicate outputs, or replays an old mutation                        | Persist request first; stable unpredictable action ids; one terminal result transition; application idempotency/deduplication; audit duplicates                     |
| Network exfiltration or lateral movement      | Shell reaches a webhook, metadata service, loopback daemon, or another tailnet node                     | Tool network off by default; egress allowlist when enabled; block private, loopback, metadata, Unix sockets, and inherited proxy credentials                        |
| Credential disclosure through process context | Agent reads environment, config, auth file, process args, or logs                                       | Broker credentials outside the tool-visible filesystem/environment; minimal child environment; redact logs; never place secrets in prompts or tool schemas          |
| User deception                                | App or agent claims a local action was approved or completed                                            | Gateway-owned approvals and audit log; trustworthy origin and authority display; distinguish app text, agent text, and verified gateway events                      |
| Sandbox escape or supervisor compromise       | Crafted command exploits bwrap, Codex, MCP, or runner                                                   | Defense in depth, least privilege host user, patched dependencies, disposable container/VM option, no host secrets, and explicit residual-risk statement            |

## Security invariants

### Authentication is not local authority

An application grant permits a bounded set of operations such as submitting a
prompt, receiving output, and servicing one approved application-tool snapshot.
It can never increase the gateway's filesystem, shell, network, MCP, plugin,
credential, model, or approval policy.

The effective authority is the intersection:

```text
application grant
AND gateway policy profile
AND OmniGENT policy
AND harness policy
AND OS/container boundary
```

A request denied by any layer stays denied. The requesting app cannot select a
less restrictive harness mode or sandbox.

### The app is never the approver for host authority

Application tool completion and gateway approval are different protocol
operations, credentials, event types, and UI surfaces. A local permission
request must be answered on a top-level gateway-owned page, authenticated
through the active transport identity. It must show the requesting app, exact
operation, affected resources, duration, and whether approval is one-time or a
policy change.

For the default remote-app profile, local permission escalation is denied rather
than prompted. This avoids training users to approve surprising shell or file
access generated by an untrusted application.

### Ambient tools are denied by default

Remote applications receive a purpose-built provider session, not the user's
ordinary interactive Codex environment. Agent Connect must construct a minimal
`CODEX_HOME` containing only what is needed for model authentication and the
selected runtime. User MCP servers, apps, plugins, memories, broad skills, shell
profiles, Git credentials, and unrelated conversation history are absent unless
the gateway owner explicitly enables a named integration profile.

### Outputs remain untrusted

Sandboxing limits consequences on the gateway; it does not make assistant
output safe HTML or make app-supplied tool results true. Applications must render
agent output safely, validate tool arguments, preserve their own authorization,
and keep mutating operations idempotent or deduplicated by action id.

## Recommended first profile: application tools only

The Firebase/list-shopping use case does not require Codex to access the VM's
filesystem or network. The default Agent Connect profile should therefore be:

```text
workspace: new empty per-app/per-session scratch directory
Codex mode: read-only
Codex tool network: disabled
local permission requests: deny
host read paths: none
host write paths: none
ambient MCP/apps/plugins: none
environment passthrough: minimal, no secrets
application tools: exact consented immutable snapshot only
provider session reuse: same app grant and snapshot only
limits: one active turn plus bounded time/tool/token/rate budget
```

The user may later create named profiles such as `repo-review`, `repo-write`, or
`calendar-draft`. Those profiles are gateway-owned configuration objects. An
application may request one, but OAuth consent cannot make it broader than what
the gateway owner previously configured. High-impact profiles require a
gateway-owned per-use approval or a narrowly stated persistent policy.

## How OmniGENT helps

OmniGENT provides useful enforcement points:

- Omnibox uses Bubblewrap namespaces plus seccomp on Linux and can restrict
  paths, environment, and network egress;
- an explicit sandbox request fails rather than silently running unsandboxed;
- contextual policies can enforce a sandbox, cap tool calls and spend, guard
  specific integrations, or ask/deny based on risk;
- the server persists session/tool history and proxies MCP calls through its
  policy layer;
- a cloud sandbox host can put the runner in a separate container.

The limitations matter just as much:

- generic ACP currently defaults to `sandbox: none`;
- Omnibox does not sandbox MCP server subprocesses or the supervisor;
- cloud-container isolation is different from per-tool filesystem/network
  policy and should be an additional layer;
- LLM-evaluated intent or prompt policies are useful heuristics, not a hard
  authorization boundary; OmniGENT documents that intent authorization fails
  open when its evaluator is unavailable;
- harness-native sandbox and approval semantics still need compatibility tests.

Therefore Agent Connect should use OmniGENT's facilities, define a
provider-neutral confinement vocabulary, and report how each claim is sourced.
It cannot independently verify a self-hosted gateway's claims. A future
OpenClaw or other adapter should use the same vocabulary even if its
implementation and evidence differ.

A Codex process launched directly as the gateway's VM user is not an isolated
profile. Launch arguments, configuration inspection, and canary probes can
detect some mistakes, but they do not remove ambient filesystem, credential,
process, or network authority and do not constitute remote attestation.

## Implementation and validation sequence

1. Add a gateway input-event allowlist. For an application session, accept only
   a task message, result for a currently unresolved application action, and
   cancellation. Reject approval/policy/session-management and unknown events.
2. Split application-action completion from gateway approval into separate
   typed endpoints and credentials before exposing any approval UI.
3. Generate a minimal, isolated provider home rather than copying the user's
   full Codex configuration. Inventory every inherited MCP/app/plugin/skill.
4. Provision an empty per-app scratch workspace and force `codex-acp` read-only
   mode with local escalation denied.
5. Add gateway-enforced concurrency, rate, time, tool-call, and budget limits;
   do not depend solely on model or application cooperation.
6. Spike explicit Omnibox `linux_bwrap` around the generic ACP harness. Prove
   Codex authentication, model access, client tools, cancellation, restart, and
   nested sandbox behavior. Fail closed if the requested backend is absent.
7. Add adversarial tests that bypass the SDK and submit malformed, replayed,
   cross-session, unknown, and approval-like event types.
8. Add real tests where malicious prompts and tool results attempt to read home,
   environment, credentials, another app's state, local services, and external
   network endpoints. The oracle is denied access, not model refusal text.
9. Add a disposable container/cloud-sandbox profile for users who want a
   stronger host boundary, while documenting container and supply-chain risk.
10. Only then add explicit gateway-owned profiles for repository or external
    integration access.

## Validation floor

Confidence in a trusted deployment requires real enforcement evidence:

- process-level filesystem and network probes from the live Codex/ACP session;
- direct gateway requests that bypass the SDK;
- approval spoofing and confused-deputy attempts;
- cross-origin, cross-session, and stale-action attempts;
- inspection of the actual spawned process environment, mounts, children, and
  effective OmniGENT/Codex policy;
- fail-closed startup tests with Bubblewrap missing or deliberately invalid;
- confirmation that no ambient MCP/app/plugin capability appears in `/mcp`,
  tool lists, or a live session;
- kill/revoke tests proving active work stops and cannot resume with stale
  credentials.

Passing unit tests or observing the model refuse a malicious prompt is not
evidence of confinement.

## Residual risks

Even after the first profile is complete:

- a compromised gateway host can read data before or after the sandbox;
- an exploit in the kernel, Bubblewrap, OmniGENT, Codex, or an allowed tool can
  escape intended boundaries;
- model prompts and application data are disclosed to the configured model
  provider according to that provider's terms;
- the application can misuse data the user intentionally gives it and can lie
  in its own UI;
- a gateway-owned integration profile can still be over-broad;
- availability and subscription costs can be bounded but not made free.

Agent Connect should report the configured confinement profile, who asserted
it, and any named observations or external attestation. It must not display a
generic "sandboxed" badge or call gateway-local inspection independent
verification.

## Sources

- [OmniGENT Omnibox OS sandbox](https://omnigent.ai/docs/policies/os-sandbox)
- [OmniGENT built-in policies](https://omnigent.ai/docs/policies/builtin)
- [OmniGENT harnesses and generic ACP behavior](https://omnigent.ai/docs/build/harnesses)
- [OmniGENT shared-server architecture](https://omnigent.ai/docs/deploy/overview)
- [OmniGENT cloud sandbox host](https://omnigent.ai/docs/deploy/cloud-sandbox-host)
- [OmniGENT collaboration warning](https://omnigent.ai/docs/collaborate)
- [`codex-acp` package documentation](https://www.npmjs.com/package/@agentclientprotocol/codex-acp)
