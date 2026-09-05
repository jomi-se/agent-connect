# Current architecture and remaining acceptance boundary

[ADR 0012](../decisions/0012-openclaw-policy-gateway.md) replaces the earlier
bundled Omnigent runtime/response-translation design. The implementation is on
the isolated replacement branch; selected subscription runtime, final browser
composition and live cutover remain gated by the
[replacement contract](../plan/openclaw-replacement.md).

## Component map

```text
application / browser
  standard Responses client or @open-agent-connect/web SDK
  immutable tool snapshot, local tool execution, conversation controls
                 |
                 | bounded Responses HTTP/SSE + grant/session authority
                 v
Agent Connect policy gateway
  enrolled identity, owner consent, PKCE, application grants
  opaque sessions, local response/call ownership, latest checkpoint
  durable tool publication and no-redrive output-attempt ledger
  allowlisted upstream requests and operator-pinned routing
                 |
                 | OpenClaw Responses + server-only token/private session key
                 v
OpenClaw + explicitly selected runtime
  inference, history, compaction, credentials and process behavior
  operator-configured application-tools-only profile
```

The gateway is not a second agent platform. It does not retain an Omnigent
backend, supervise downstream harness processes, maintain a retained-run
protocol or translate provider events into another agent vocabulary.
Normalization is limited to the bounded public Responses shape and model
identity; security-relevant upstream structure is validated before forwarding.

## Ownership boundaries

### Application and SDK

The application owns its tools and actual side effects. It must make
consequential operations idempotent or journal results using stable call IDs;
neither a lost acknowledgement nor a transport retry proves an external
operation did or did not execute.

The SDK owns browser transport, function registration/execution, application
mutation confirmation and response-segment coordination. Its headless state
and native WebMCP integration remain harness-neutral. It cannot authorize
gateway filesystem, shell, network, MCP or runtime permission requests, and
does not receive private runtime keys or operator credentials.

Open Responses is the application vocabulary. ACP/MCP-over-ACP browser
helpers remain experimental. AG-UI is a possible future edge adapter, not
another execution core.

### Gateway identity and authority

The one-shot initializer exports a runtime card and enrollment passphrase
through the trusted operator channel, persisting only a salted verifier.
Normal serving requires initialized state and never takes the plaintext
passphrase. Applications import the public card and verify a fresh challenge
before tool disclosure. A URL is a transport hint, not proof of identity.

The gateway-owned authorization page presents the exact Origin, application
ID, callback, scopes and tool metadata snapshot. S256 PKCE protects the
authorization code; the resulting grant is revocable and Origin-bound.
Approval authorizes declared tool metadata, not the implementation of the
application's handlers. App-instance sender binding remains future hardening.
See [ADR 0007](../decisions/0007-runtime-card-and-gateway-authorization.md).

A previously unknown HTTPS Origin may enter bounded authorization bootstrap
under the Tailscale Serve profile. It gains no operational access until
approval, and approval does not add it to a global trust list. An optional
Origin allowlist can impose stricter operator policy.

Tailscale Serve terminates HTTPS and supplies authenticated requester identity
to the loopback gateway. The gateway validates the allowlisted owner identity
and application authority separately. Recognizing a `.ts.net` suffix is not
an identity check. See [ADR 0005](../decisions/0005-trusted-transport-profiles.md).

### Gateway policy mediation and ledger

A grant always creates an independent opaque application session. Only a
capability naming that session reconnects to it. The gateway allocates a
private stable OpenClaw session key; it never adopts the newest matching
conversation or replaces an unhealthy conversation transparently.

Operator configuration supplies the OpenClaw URL, token and selected agent.
The gateway builds fresh headers and a bounded request body, rather than
forwarding application-selected routing or credentials. It supplies the fixed
approved tool snapshot on every segment, including output continuation.

The durable ledger owns application/session/response/call relationships,
latest-checkpoint admission, publication eligibility and output-attempt
state. Upstream response IDs are not authorization tokens. Local ownership
checks remain authoritative even when OpenClaw's memory-only response cache
expires; explicit private session routing avoids implicit cache-based adoption.

The gateway persists a call before exposing any corresponding tool
notification, including through recovery GET. It persists an output attempt
before sending it upstream. Repeated or conflicting submissions cannot
redrive the call, and ambiguous acceptance requires an honest interruption
instead of automatic replay.

Recovery reports known state, not a reconstructed agent run. Interrupted or
superseded calls whose continuation is impossible are not offered for
execution. Old Omnigent chain files retain their application authority but
are explicitly unavailable for OpenClaw continuation. Gateway identity,
devices and grants remain readable without reinterpretation or rotation.

The owner session console provides local retirement and capacity management,
with idle, parked-call and total-request bounds. It labels interrupted state
and unavailable usage honestly. Local cancellation/revocation prevents further
tool publication; actual upstream generation stopping requires runtime-specific
evidence and a bounded operator timeout. It is not implied by a closed client
socket or a locally ended session.

### OpenClaw and runtime policy

OpenClaw owns inference, conversation history, compaction, runtime credentials
and process behavior. The gateway calls its public Responses API, not private
plugin interfaces. The operator must disable host shell/filesystem/network/MCP
tools for application delegation. Declaring client tools alone does not
confine an agent, and this request boundary does not establish an OS sandbox.

Published OpenClaw 2026.9.1's built-in loop passes deterministic client-tool
tests. Its separately pinned native Codex adapter drops the client-tool
definitions; native Codex support cannot be inferred from built-in-loop tests.
The selected subscription runtime and final live browser gate remain open.

The built-in loop projects submitted client-tool output as user text after a
synthetic delegated result, not as a restored native tool-role response.
Acceptance must demonstrate meaningful consumption of the actual application
result with the selected runtime. See the
[dated dependency investigation](../research/2026-09-05-openclaw-replacement.md).

## Application-tool round trip

1. The user approves an immutable tool snapshot through gateway-owned consent.
2. The application grant creates an opaque session and private upstream key.
3. The SDK sends a bounded response request using `agent-connect/default`.
4. The gateway validates authority and the latest checkpoint, reserves admission,
   records the attempt and calls OpenClaw with approved tools and private routing.
5. OpenClaw produces Responses events. The gateway validates them and holds
   function notifications until the call and continuable checkpoint are durable.
6. The SDK executes the approved local function and returns its correlated output.
7. The gateway records the no-redrive boundary before forwarding that output,
   re-injecting approved tools and the same private session key.
8. OpenClaw generates the next segment. A later user follow-up explicitly names
   the latest completed response; the gateway never infers a session from a grant.

There is no retained backend run to reattach, no transcript-replay fallback and
no silent switch to another model or harness.

## Historical designs and deferred work

[ADR 0010](../decisions/0010-open-responses-gateway-pivot.md) introduced the
public Responses boundary and the now-superseded bundled Omnigent backend.
Earlier Codex/Tailscale browser demonstrations remain historical baseline
evidence, not acceptance for the replacement.

The [Omnigent sandbox spike](../research/2026-07-14-omnigent-vm-sandbox-spike.md)
and [containerized deployment plan](../plan/containerized-gateway-deployment.md)
record earlier experiments; they are not current OpenClaw deployment promises.
The [confinement decision](../decisions/0008-control-plane-and-runtime-confinement-boundary.md)
and [malicious-application threat model](../research/2026-07-14-malicious-application-runtime-threat-model.md)
remain useful boundary rationale, but their historical provider mechanisms
must not be mistaken for independently verified current isolation.

No automatic direct-Codex fallback or second permanent backend is planned.
ACP remains a possible future runtime-side standard, and
[AG-UI](../research/2026-07-14-ag-ui-fit.md) remains a deferred application-edge
integration. Neither changes the current application contract.
