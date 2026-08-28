# Containerized gateway deployment

Status: pending architecture and deployment spike

## Opportunity

Package the reference Agent Connect setup as a gateway deployment that
can run on an arbitrary Internet-connected container host. The appliance would
compose the Agent Connect gateway, Omnigent control plane and runner, Codex ACP
adapter, dynamic application-tool relay, gateway-owned enrollment and OAuth
pages, and operator diagnostics behind one documented deployment boundary.

This is more than a sandbox replacement. It is a possible installation and
distribution model: deploy one image or Compose application, inject the user's
agent authentication through a deliberate bootstrap channel, publish one HTTPS
endpoint, export the runtime card, and connect applications without requiring
the user to understand Omnigent, Bubblewrap, or the internal service topology.

The container is still user-owned infrastructure. Agent Connect remains
harness-neutral at its application boundary; this image is the opinionated
Omnigent/Codex reference gateway, not a requirement imposed on other runtime
adapters.

## Why investigate it

- It avoids nesting Omnigent and Codex Bubblewrap policies.
- It can keep the host home, SSH material, application repositories, and other
  ambient VM state outside the agent execution boundary.
- It gives the dynamic MCP relay a reproducible filesystem and dependency
  layout instead of mounting a user-specific Omnigent installation.
- It turns the current multi-step VM setup into the basis for a one-command or
  one-click deployment.
- It can run behind a conventional HTTPS endpoint, a private overlay network,
  or a managed container ingress. Tailscale becomes one supported transport
  profile rather than the installation architecture.
- The same appliance can later support another harness through the existing
  internal runtime adapter boundary.

## Deployment profiles to distinguish

### Single long-running appliance

One container or Compose application contains the gateway, Omnigent server and
host/runner, Codex adapter, and relay. Each Agent Connect session receives a
fresh private workspace directory inside the container.

This is the first target because it is operationally small and protects the
underlying host when no host directories or container-runtime socket are
mounted. It does **not** provide a strong boundary between sessions that share
the container, process namespace, credentials, or writable state.

### Per-session runner container

The control plane remains long-lived while every downstream agent session runs
in a fresh container with its own filesystem, process namespace, resource
limits, network policy, and teardown lifecycle. This is the stronger target.
It may require an Omnigent container-host adapter or fork unless an existing
managed-host API can provision a local container runner without exposing the
host Docker socket to agent-controlled processes.

### Managed container deployment

Deploy the same logical appliance through a supported Internet-facing
container platform. The platform may provide HTTPS ingress, secret injection,
volumes, workload identity, resource limits, and per-instance lifecycle. These
features are deployment evidence, not generic remote attestation, and must be
reported with their actual source.

## Proposed appliance boundary

```text
browser application
        |
        | HTTPS + gateway identity + application grant
        v
container appliance
  Agent Connect gateway and gateway-owned UI
  Omnigent server and selected host/runner
  codex-acp + Codex + dynamic tool relay
  gateway state volume
  ephemeral per-session workspaces
        |
        | restricted model/provider and optional web egress
        v
external services
```

The first implementation should run Codex without an inner Bubblewrap sandbox
and treat the container as the primary process/filesystem boundary. It must not
mount the host home or container-runtime socket. A later experiment may enable
Codex's native sandbox inside a compatible image, but nested user namespaces
are not an acceptance requirement.

## Authentication and state bootstrap

The appliance needs at least three distinct state classes:

1. **Gateway identity and grants.** Persist the gateway private key,
   authorization grants, revocations, and audit data in a dedicated encrypted
   or access-controlled volume. Recreating the container must not silently
   change the enrolled gateway identity.
2. **Agent authentication.** Support an explicit bootstrap path for the user's
   Codex authentication. Initial experiments may import a dedicated Codex home
   or secret file, but production design must investigate interactive login,
   platform secret stores, short-lived credentials, and a credential broker.
   The credential must not be baked into the image or copied into session
   workspaces.
3. **Session data.** Create a mode-`0700` workspace and disposable Codex
   session/cache state for each downstream session. Delete them on normal
   closure and by TTL after crashes. Any persistence must be separately named
   and mounted.

Container isolation protects the host but does not by itself keep an agent
credential secret from a malicious authorized application that can influence
the agent. Credential visibility and egress remain explicit threat-model work.

## Transport and enrollment consequences

The runtime-card and gateway OAuth design still applies. The application
trusts the enrolled gateway key, not a hostname or hosting vendor. The
appliance can therefore support several transport profiles:

- Tailscale Serve for a private user-owned endpoint and requester identity;
- a managed HTTPS ingress with an explicitly configured user identity provider;
- a custom domain with gateway-key continuity but no transport identity
  claim beyond TLS; or
- a future relay that routes encrypted traffic without becoming gateway
  identity.

Moving off Tailscale removes its automatic requester-identity signal. A public
deployment must replace that signal for the gateway-owned authorization page
with an identity provider, a local enrolled-device credential, or another
explicit presence mechanism. CORS and gateway-key proof do not authorize a
person to spend the user's agent subscription.

The hackathon temporarily used a separate anonymous gateway through Tailscale
Funnel. That judge-only deployment and its `public-demo` transport profile were
removed after judging. This plan now concerns future user-owned packaging only;
see the [archived judge environment plan](judge-demo-environment.md) for the
historical experiment.

## Pending work

### Phase A: feasibility and image composition

- Inventory every process, port, persistent path, temporary path, binary, and
  health check used by the current gateway/Omnigent/Codex loop.
- Build a reproducible image containing pinned Omnigent, `codex-acp`, Codex,
  and the dynamic relay; do not depend on host-installed `uv` paths.
- Add gateway-owned per-session workspace allocation, ownership, TTL cleanup,
  and an explicit persistence policy.
- Start the appliance without mounting the host home or Docker socket and
  complete the existing dynamic `set_page_message` browser loop.
- Document a development-only agent-auth import and ensure it never enters the
  image layers, logs, runtime card, browser events, or session workspace.

### Phase B: secure deployment profile

- Separate gateway state, agent credentials, audit state, and disposable
  session data into distinct mounts or secret channels.
- Restrict inbound ports and outbound destinations; record the minimum egress
  needed for Codex, Omnigent coordination, and intentionally enabled web use.
- Apply CPU, memory, process, task-duration, concurrency, and storage ceilings.
- Define upgrade, backup, gateway-key recovery, revocation, and rollback
  behavior.
- Add operator-visible posture that accurately distinguishes a shared
  appliance from a per-session container.

### Phase C: one-click and per-session runners

- Evaluate Compose, a generic OCI deployment template, and one managed
  container platform without making that vendor part of the public SDK.
- Prototype a per-session runner container lifecycle and determine whether it
  can use an Omnigent extension point or needs a narrow maintained fork.
- Design interactive first-run setup for gateway enrollment, user identity,
  Codex authentication, public/private ingress, and runtime-card export.
- Produce a disposable end-to-end deployment test from empty host to revoked
  application grant.

## Validation targets for the spike

- **VAL-APPLIANCE-001 — clean bootstrap:** a documented empty-host command
  starts the appliance and all health checks without host-installed Omnigent or
  Codex dependencies.
- **VAL-APPLIANCE-002 — real tool loop:** the Firebase demo enrolls, authorizes,
  invokes a dynamic application tool through Codex, and revokes access through
  the appliance's public endpoint.
- **VAL-APPLIANCE-003 — host boundary:** a session cannot read a host sentinel,
  host home, container-runtime socket, gateway identity volume, or another
  session workspace.
- **VAL-APPLIANCE-004 — lifecycle:** session workspaces are unique, mode-`0700`,
  absent from image layers, and removed after close and crash-expiry paths.
- **VAL-APPLIANCE-005 — credential handling:** agent authentication does not
  appear in the image, logs, browser protocol, runtime card, or workspace;
  remaining in-container read and exfiltration authority is documented.
- **VAL-APPLIANCE-006 — authorization:** an unapproved origin, wrong user,
  substituted gateway, revoked grant, or replayed code cannot start or use
  an agent task.
- **VAL-APPLIANCE-007 — honest posture:** the gateway reports whether the
  session used a shared appliance or a fresh runner container and does not
  promote its self-report into external attestation.

## Non-goals for the first spike

- claiming arbitrary OCI containers are trusted execution environments;
- solving provider credential exfiltration solely through containerization;
- running Docker from an agent-visible process or mounting the Docker socket;
- production multi-tenancy, billing, or a public Agent Connect relay;
- requiring this deployment model for non-Omnigent runtime adapters.
