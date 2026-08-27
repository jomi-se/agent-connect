# Current work

Updated: 2026-08-27

This is the canonical unfinished-work list. It records current priorities and
only enough completed context to explain them. Product boundaries live in the
[mission](../mission.md), capability status lives in the
[scope inventory](../scope-inventory.md), and architectural choices live in
[`docs/decisions/`](../decisions/).

## Working baseline

The hackathon MVP proved the core loop through two profiles:

- a deterministic public judge demo; and
- a source-installable Tailscale Serve gateway using a real user-owned Codex
  login through Omnigent.

The browser SDK verifies a selected gateway, obtains a revocable Origin-bound
grant, supplies an exact user-approved application-tool snapshot, streams a
task, executes requested application functions, returns correlated results,
and hides raw Omnigent identifiers.

The public task/event protocol and browser-visible Omnigent provider are
transitional. [ADR 0010](../decisions/0010-open-responses-gateway-pivot.md)
proposes replacing that public wire with a bounded Open Responses profile while
retaining Agent Connect's authorization, durability, and user-owned runtime
behavior.

The automated baseline remains:

```sh
npm run verify:full
npm run test:integration:omnigent
```

The second command uses disposable Omnigent services and a deterministic ACP
agent. A real Codex/browser composition remains a deliberate manual milestone
because it consumes the operator's credentials and model allowance.

## Priority 1: prove the Open Responses vertical slice

Implement the smallest end-to-end slice required by ADR 0010:

1. expose the documented version 0 Open Responses HTTP/SSE profile;
2. map `agent-connect/default` to one real Codex-backed execution;
3. complete multiple sequential application function calls through
   `previous_response_id` continuation;
4. preserve the exact user-approved function snapshot;
5. keep runtime-owned tools and application-owned functions distinct;
6. persist each application call before publication and retain its stable call
   ID through result submission;
7. define cancellation, interruption, recovery, malformed-call, and harness
   failure behavior; and
8. prove the slice with an ordinary Open Responses client.

Keep the passing Omnigent path until this evidence exists. After the replacement
meets the ADR gates, remove the custom browser task/event protocol and
browser-visible Omnigent path rather than maintaining two permanent public
protocols.

WebMCP is not part of this milestone. Explicit browser tool registration is the
version 0 source of the fixed approved snapshot.

## Priority 2: one-click user-owned deployment

Turn the working source profile into an installation a normal technical user
can launch without understanding Omnigent, ACP, MCP, or the internal service
topology.

The first proof should favor one reproducible deployment over a generalized
deployment framework. GitHub Codespaces is a promising low-friction entry
point, but private forwarded-port authentication, mobile browser behavior,
sleep, and manual wake-up still need a focused prototype. Tailscale remains a
power-user path. Do not make a founder-operated relay mandatory.

The deployment must make credential injection, update, restart, gateway-card
export, health, and teardown explicit. Packaging convenience is not a claim of
process isolation, credential confinement, or multi-tenancy.

## Priority 3: interruption durability and operator basics

These are the most important reliability gaps after the protocol slice:

1. recover unresolved application calls independently from conversation
   resumption;
2. make duplicate function-result submission idempotent;
3. persist logical-run, response-chain, and provider-session mappings needed
   across gateway restart;
4. propagate revocation and cancellation to downstream work;
5. expire successful workspaces and replaced provider sessions; and
6. add small operator commands for runtime-card re-export, device management,
   gateway-key rotation, recovery, and audit history.

Use stable action IDs and require idempotent application operations or
application-owned deduplication. Do not claim generic exactly-once execution.

## Priority 4: compelling applications

Once the Open Responses scaffold works, validate the product through real
applications rather than further protocol invention. A useful application
should:

- solve a problem the user genuinely has;
- benefit materially from a powerful user-owned runtime rather than a single
  ordinary model request;
- use application-owned functions in a way that justifies Agent Connect; and
- make the gateway infrastructure mostly invisible.

A personalized study/tutoring system backed by user-provided technical sources
is one candidate. Its product test is whether persistent progress, source-aware
lessons, exercises, and agent-driven application actions produce something
meaningfully better than an ordinary document-chat product. Select and build
one narrow application before expanding into a generic application platform.

## Bounded maintenance

Maintenance is justified when it unblocks one of the priorities above:

- preserve provider-neutral browser APIs and keep Omnigent/Codex types internal;
- resolve `gateway` versus legacy `connector` terminology when touching the
  relevant surface;
- add structured logging, SSE cancellation/backpressure, and stable error
  mapping as required by the Open Responses slice;
- remove obsolete scaffolding at the migration deletion point; and
- publish `@agent-connect/web` only after its compatibility and security claims
  match the tested package.

Do not undertake broad route-framework rewrites, speculative harness
frameworks, mass renaming, or generalized-provider refactors for architectural
neatness alone.

## Deferred or optional

- AG-UI: optional future edge adapter only for a concrete UI need;
- ACP: optional harness-facing adapter where stable capabilities fit;
- MCP and harness-native dynamic tools: backend techniques, not public
  requirements;
- WebMCP: possible future browser-side source of candidate tool definitions,
  still subject to exact snapshot approval;
- a second backend: add after the Codex/Open Responses slice reveals the real
  adapter seam;
- arbitrary multi-agent orchestration;
- Android automation;
- public multi-tenancy, billing, or a mandatory hosted relay;
- hardware-attestation claims; and
- replacing Omnigent solely to make the architecture look more neutral.

## Historical material

The Build Week submission, judge environment, AG-UI spike, sandbox experiment,
and container deployment plan remain useful dated records. They are not the
current backlog unless an item above links to them explicitly.
