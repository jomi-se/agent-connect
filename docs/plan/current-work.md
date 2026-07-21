# Current work

Updated: 2026-07-20

This is the canonical backlog. It records only unfinished work and the smallest
amount of completed context needed to understand it. Accepted architectural
choices live in [`docs/decisions/`](../decisions/); reproducible operator flows
live in [`deploy/`](../../deploy/).

## Working baseline

The repository currently contains two end-to-end profiles:

- a public, deterministic judge demo exposed through Tailscale Funnel;
  it exercises enrollment, consent, PKCE, Omnigent, ACP, request-scoped MCP,
  browser-owned tools, visible mutations, revocation, and reboot recovery
  without a model credential; and
- a source-installable Tailscale Serve profile that runs the same application
  contract against a real user-owned Codex login through Omnigent.

`@agent-connect/web` can be packed and installed into an external npm project,
but it is not yet published to npm. The Firebase Canvas accepts either
profile's runtime card and demonstrates live-state reads plus project-board,
document-review, and product-research mutations.

The automated floor is:

```sh
npm run verify:full
npm run test:integration:omnigent
```

The first command covers formatting, types, behavior tests, builds, a clean
SDK-package consumer, and Canvas browser tests. The second starts disposable
real Omnigent services with a deterministic ACP agent. A real Codex/browser
composition remains a manual milestone because it consumes the operator's
credentials and model allowance.

## Submission critical

The engineering MVP is complete. Before the Build Week deadline:

1. Rehearse the exact private judge instructions in a clean browser, including
   enrollment, one useful Canvas task, grant revocation, logout, and reconnect.
2. Record and publish a narrated video shorter than three minutes. Clearly
   label the deterministic public fixture and the separate real-Codex proof.
3. Confirm the Devpost entry contains the `/feedback` identifier, public demo
   URL, private runtime card/passphrase delivery, repository access, and
   developer-tool installation/testing path.
4. Run both verification commands above, check the public demo after a
   restart, and confirm the submission is actually submitted rather than saved.
5. Keep the judge demo healthy through `2026-08-06T00:00:00Z`, then
   disable Funnel and destroy its disposable state.

The detailed presentation checklist is in
[the submission guide](openai-build-week-submission.md). The deployment and
kill-switch procedure is in [the judge demo runbook](../../deploy/judge-demo/README.md).

## Reliability and operator work

These are real product gaps, not submission blockers:

1. Persist unresolved application tool requests before notifying the app, and
   recover them separately from conversation resumption.
2. Persist logical-to-provider session mappings and short-lived authorization
   transactions where restart recovery is required.
3. Expire and remove successful session workspaces and replaced provider
   sessions; failed launches are already cleaned immediately.
4. Add operator commands for runtime-card re-export, device management,
   gateway-key rotation, recovery, and audit history.
5. Add one coherent public-endpoint usage policy. Transient authorization
   state and passphrase verification are bounded today, but sustained request
   budgets and downstream-work termination on revocation are not complete.
6. Add app-instance proof/DPoP only if the copied-bearer-token threat justifies
   its complexity.
7. Remove the temporary Omnigent built-in-name collision policy by introducing
   provider-owned tool namespacing or an upstream contract. The reference
   profile remains pinned to Omnigent 0.5.1 meanwhile.

Use stable action IDs and require idempotent application operations or
application-owned deduplication. Do not claim generic exactly-once execution.

## Packaging and compatibility

1. Publish `@agent-connect/web` after its compatibility policy and security
   claims match the tested package.
2. Turn the source launcher into a reproducible gateway deployment with
   deliberate credential injection and an explicit update path.
3. Add another provider only after it proves the existing provider-neutral
   application contract. Do not add a second proprietary session protocol
   without an ADR.

## Bounded experiments

- [AG-UI compatibility](ag-ui-compatibility-spike.md): determine whether its
  run/event/frontend-tool vocabulary can replace the custom browser/gateway
  event language while Agent Connect retains identity, authorization, runtime
  ownership, and recovery.
- [Containerized gateway deployment](containerized-gateway-deployment.md):
  distinguish a convenient shared appliance from a stronger per-session
  runner boundary. Containerization alone is not credential confinement or
  host attestation.
- Direct browser ACP and MCP-over-ACP: revisit only when the unstable path is
  supported end to end; keep draft-specific types out of the default API.
- Runtime confinement: prefer disposable workspaces and container/managed
  runner boundaries. The Bubblewrap experiment is evidence, not a supported
  profile.

## Explicitly deferred

- generalized multi-agent orchestration;
- arbitrary MCP server support;
- Android automation;
- hardware-attestation claims;
- verification of a provider's self-reported sandbox posture; and
- replacing Omnigent solely to make the architecture appear more neutral.
