# Scope and capability inventory

## Application-facing web SDK

| Capability                                           | Current milestone | Observable evidence                                                                            |
| ---------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| Create an opaque application session                 | Session slice     | Browser receives no OmniGENT id                                                                |
| Pair user presence through a private channel         | Legacy slice      | Disabled when enrolled connector authorization is configured                                   |
| Export reusable runtime identity once                | Implemented       | Durable Ed25519 runtime card is emitted only on first state creation                           |
| Authorize a new app without terminal access          | Implemented       | Connector-owned page returns a PKCE-protected scoped grant                                     |
| Prevent application-driven policy expansion          | Security slice    | App cannot broaden runtime filesystem, network, integration, credential, or approval authority |
| Report runtime posture without overstating assurance | Security slice    | SDK separates configured claims, named probe observations, and external attestation            |
| Bound subscription and availability abuse            | Security slice    | Connector enforces per-app concurrency, time, tool, cost, and rate ceilings                    |
| Separate app results from host approval              | Security slice    | App credentials cannot answer connector, harness, OS, MCP, or policy approvals                 |
| Reach a user-owned runtime from an HTTPS web app     | Remote slice      | Tailnet-only HTTPS gateway enforces Origin and Tailscale identity                              |
| Verify continuity with an enrolled runtime           | Identity slice    | Connector proves possession of the key bound during first-use enrollment                       |
| Report transport/runtime assurance                   | Identity slice    | SDK distinguishes Tailscale transport, connector-key proof, and unverified claims              |
| Mutate visible state from a dynamically lent tool    | Remote demo       | Firebase Canvas exposes one bounded in-memory page-write tool                                  |
| Supply a fixed request-scoped tool snapshot          | Browser slice     | First message event carries OpenAI-format dynamic tool schemas                                 |
| Stream normalized task progress                      | Browser slice     | Text, lifecycle, and tool events are observable incrementally                                  |
| Execute a typed application tool handler             | Browser slice     | `action_required` invokes the registered handler exactly once                                  |
| Return a correlated result                           | Browser slice     | `function_call_output` preserves the OmniGENT `call_id`                                        |
| Reject malformed/unknown tool calls and HTTP errors  | Browser slice     | Unit tests observe stable public errors                                                        |
| Cancel an active task                                | Browser slice     | Client posts an interrupt event                                                                |
| Connect to ACP over browser WebSocket                | Experimental      | Existing transport helper remains isolated                                                     |
| Register one application-owned MCP server            | Experimental      | Existing narrow MCP-over-ACP handler remains isolated                                          |
| Speak AG-UI between application and gateway          | Exploration       | Official client completes the live Codex frontend-tool flow                                    |
| Stream ACP session updates                           | Conductor spike   | Browser receives Codex text/tool progress                                                      |
| Confirm application-owned mutation                   | Demo slice        | Browser may confirm its own tool side effect, never connector or host authority                |
| Reconnect and load an agent session                  | Reliability slice | New transport loads the stored session ID                                                      |
| Recover unresolved application action                | Reliability slice | Pending action is listed or redispatched after reconnect                                       |
| Prevent duplicate demonstrated spreadsheet mutation  | Reliability slice | Stable action ID and spreadsheet deduplication produce one write                               |

## Conductor and OmniGENT provider

| Capability                                         | Current milestone | Main risk                                                            |
| -------------------------------------------------- | ----------------- | -------------------------------------------------------------------- |
| Use existing OmniGENT HTTP/SSE session transport   | Browser slice     | Browser CORS/auth deployment still needs real-surface proof          |
| Pass request-scoped tools into the first turn      | Proven spike      | Live nonce composition passed on 2026-07-13                          |
| Drive maintained `@agentclientprotocol/codex-acp`  | Proven spike      | Live Codex turn completed with published adapter 1.1.2               |
| Round-trip `action_required` tool output           | Proven spike      | Exact-once callback and same-turn completion observed                |
| Provision and bind runners                         | Session slice     | Gateway uploads the fixed agent bundle and selects one host          |
| Reuse a healthy matching session                   | Session slice     | Same origin/app/tool hash resolves to one logical session            |
| Heal an offline matching runner                    | Session slice     | Gateway transparently provisions a replacement runner                |
| Persist pending application actions                | Reliability slice | OmniGENT currently does not persist `action_required` calls          |
| Run the reference connector as an OCI appliance    | Exploration       | Shared container protects the host but not sessions from one another |
| Allocate a private workspace per runtime session   | Exploration       | Gateway owns creation, mode, binding, expiry, and cleanup            |
| Launch a fresh runner container per session        | Future security   | May require an OmniGENT host adapter or maintained fork              |
| Publish an isolated judge connector through Funnel | Submission        | Public transport must not weaken private Serve identity enforcement  |

## Security and reliability constraints

- Application tools are explicit, typed, session-scoped, auditable, and revocable.
- The deployed gateway listens on loopback behind Tailscale Serve HTTPS.
- Browser origins and Tailscale logins are exact allowlists; CORS is not user authentication.
- A `.ts.net` hostname is not identity evidence by itself. The Tailscale profile
  requires private Serve posture, loopback isolation, requester identity, and a
  user-approved binding to the connector key.
- Mutating tools require visible approval or a preview policy.
- The conductor authenticates and pairs applications; raw Codex app-server is never internet-exposed.
- The enrolled profile emits a public runtime card plus generated enrollment
  passphrase once, and disables the legacy pairing exchange. The passphrase is
  entered only on the connector-owned page; per-app consent uses PKCE grants.
- Application capabilities are signed, expiring, and bound to origin, app id,
  logical session id, and canonical tool-snapshot hash.
- Prompt ingress is an execution capability: an authenticated application may
  instruct the agent, but it cannot raise the agent's local sandbox or approval
  policy through Agent Connect.
- The target runtime profile uses an empty
  isolated workspace and only the consented application tools. Ambient MCP
  servers, apps, plugins, skills, host paths, and tool network access are
  absent. Runtime adapters own the enforcement mechanism; Agent Connect owns
  policy selection, non-expansion, and honest posture reporting. A direct
  same-user Codex process cannot satisfy this isolated profile. The current
  VM-local bwrap experiment proves the outer mount/seccomp boundary but not the
  complete dynamic-tool loop; it remains experimental.
- Application events are explicitly schema-allowlisted. Unknown and
  approval-like events fail closed rather than being proxied to a provider.
  Correlation of tool results to a persisted unresolved action remains part of
  the durability milestone.
- Stable action IDs are preserved across retries and reconnects.
- The demo application's mutation endpoint is idempotent by action ID.
- Loss of token deltas is acceptable; loss of an unresolved mutation request is not.

## Validation readiness

- Layer 1, connector behavior: public TypeScript imports and real HTTP requests
  against an in-process gateway under Vitest. Provider behavior is injected so
  authorization, capability, origin, requester-identity, session, and event
  policy branches remain fast and deterministic.
- Layer 2, provider contract: an opt-in disposable local OmniGENT server and
  host drive a deterministic ACP agent over the real stdio protocol. This layer
  must validate runner provisioning, the uploaded agent bundle, ACP
  initialization/session/prompt traffic, request-scoped MCP tools/list and
  tools/call, the correlated application result, OmniGENT HTTP/SSE translation,
  and isolated on-disk state without using Codex credentials or model tokens.
- Layer 3, live composition: a manual milestone smoke test uses the real
  OmniGENT/Codex chain and deployed browser. It proves the final composition but
  is intentionally excluded from routine automated tests because it consumes
  credentials and model tokens.
- Browser surface: add a small local real-browser suite when browser-enforced
  CSP, CORS, cookie, redirect, or storage regressions justify it; do not require
  a permanent tailnet CI runner.
- Persistence surface: database state before request, while pending, and after completion.
- Downstream surface: a live Codex turn authenticated with the user's existing Codex login.

The connector tests do not attempt to prove Tailscale or WireGuard. They prove
that Agent Connect accepts the configured trusted-proxy identity shape and
fails closed for missing, unexpected, or ambiguous identities. The real
OmniGENT layer exists specifically to avoid a fake provider merely reproducing
Agent Connect's own mistaken assumptions about OmniGENT.

The live unsandboxed Codex composition environment is established. The next
validation gates are the deployed mobile enrollment flow and resolving (or
replacing) the sandboxed OmniGENT MCP child startup path.

The pending container-appliance track must independently validate clean-host
bootstrap, the real application-tool loop, host and cross-session boundaries,
credential leakage surfaces, ephemeral cleanup, application authorization, and
honest runtime-posture reporting. A shared appliance and a per-session runner
container are different assurance profiles.

The submission-critical judge profile reuses the existing VM but has separate
connector identity, enrollment, grants, Codex credential, state, container, and
workspaces. Public Tailscale Funnel replaces private Serve transport only for
that profile; enrolled-device and application authorization replace the missing
tailnet-user identity. The personal Serve connector remains private and
unchanged.
