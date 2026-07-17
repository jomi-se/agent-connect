# Judge demo environment

Status: implementation-ready plan; submission-critical

## Purpose

Provide OpenAI Build Week judges with a free, working Agent Connect environment
that does not require joining the developer's tailnet, rebuilding the project,
or receiving access to the developer's personal connector or Codex login.

The minimum deployment reuses the existing VM and publishes a separate judge
connector through Tailscale Funnel. It uses the deterministic ACP agent already
used by the real OmniGENT integration suite, not the owner's Codex subscription
or a paid model credential. Firebase continues to host the static Canvas
application. The real Codex composition remains the recorded and private live
proof; the public sandbox proves that a clean judge can exercise the same SDK,
authorization, OmniGENT, ACP, dynamic-tool, and page-mutation boundaries.

The judge environment must remain available through the official end of
judging, 2026-08-06 00:00 UTC (August 5 at 5:00 PM Pacific Time), and should be
disabled and have its credentials revoked immediately afterward.

## Current host fit

Observed on 2026-07-15:

- 4 CPUs;
- 23 GiB RAM, approximately 20 GiB available;
- approximately 83 GiB filesystem space available;
- Docker 29.2.1;
- Tailscale 1.98.4 with Funnel capability;
- private Tailscale Serve routes already occupy HTTPS ports 443 and 8443; and
- Funnel-supported port 10000 is unused.

This is ample for the separate gateway, OmniGENT, and deterministic ACP
composition. No new VM or model credential is required for the judge sandbox.

## Topology

```text
https://agent-connect-demo.web.app
  Firebase Canvas
          |
          | exact-origin browser requests
          v
https://artifex-box.tail246db1.ts.net:10000
  Tailscale Funnel: public HTTPS
          |
          | loopback proxy only
          v
127.0.0.1:<judge-port>
  Compose judge boundary
    gateway container
      Agent Connect API and authorization UI
      dedicated connector-state volume
    OmniGENT server container
      dedicated SQLite/artifact volume
    OmniGENT host container
      deterministic ACP agent and request-scoped MCP relay
      disposable tmpfs home, temp, and workspace
```

The eventual exposure command is expected to have this shape after the judge
gateway passes loopback validation:

```sh
sudo tailscale funnel --bg --https=10000 http://127.0.0.1:<judge-port>
```

Do not run this command until the public-demo authorization profile and runtime
ceilings pass locally. `--bg` makes the Funnel configuration resume after a
Tailscale or host restart. Capture `tailscale funnel status --json` as deployment
evidence.

## Isolation from the personal connector

The judge deployment must not reuse or expose the private connector currently
served through Tailscale Serve. The deterministic ACP agent intentionally has
no model, filesystem tool, ambient MCP authority, or prompt-to-process path,
but it must spawn OmniGENT's request-scoped MCP relay. A parser, dependency, or
protocol-handler RCE would therefore be serious if the stack ran as the VM's
normal `dev` user. The minimum public profile uses a three-container Compose
boundary rather than relying only on application-level tool restrictions.

It receives its own:

- connector identity and runtime card;
- enrollment passphrase and enrolled devices;
- application grants, revocations, and audit state;
- OmniGENT state and downstream sessions;
- no Codex or model authentication at all;
- isolated container state and workspace root; and
- logs and shutdown lifecycle.

Run every container as a non-root user with a read-only root filesystem,
default seccomp, all Linux capabilities dropped, `no-new-privileges`, bounded
PIDs/CPU/memory, and writable tmpfs only where required. Do not mount the host
home, repository, normal `~/.codex`, SSH material, or Docker socket. Only the
gateway receives the connector-state volume; only the OmniGENT server receives
its database/artifact volume. The host/agent receives disposable tmpfs state.

Use two internal Docker networks: gateway-to-server and server-to-host. The
host/agent must not directly reach the gateway or the Internet. Only the
gateway port is published, bound to host loopback for Funnel. This is strong
defense in depth, not a claim that an ordinary container is a TEE or that
kernel escapes are impossible. The request-scoped MCP relay is a child process
inside the host container and talks to the application through OmniGENT's
existing server-mediated protocol path; it does not require direct runner-to-
gateway network access. The OmniGENT server necessarily bridges both internal
networks, so a runner compromise that becomes a server compromise may still
attempt to pivot toward the gateway. Preserve gateway authentication on that
network and report this residual path rather than claiming arbitrary-RCE
containment.

## Public-demo transport profile

Tailscale Funnel provides public HTTPS transport, not an authenticated tailnet
user. The current `tailscale-serve` profile requires the trusted
`tailscale-user-login` header and must remain unchanged.

Add a separately named `public-demo` profile whose authorization requires:

- the exact Firebase Canvas Origin and callback;
- proof of the connector key from the imported judge runtime card;
- a high-entropy judge enrollment passphrase entered only on the connector
  origin;
- the resulting enrolled-device credential;
- a PKCE application grant bound to origin, app id, scopes, tool snapshot, and
  expiry;
- the exact configured Firebase app id and `set_page_message` tool snapshot;
  and
- connector-owned global rate, concurrency, prompt-size, task-time, pending
  authorization, and managed-session limits.

`public-demo` uses an internal public-demo device principal; it must not invent
or accept a fake Tailscale user identity. The authorization page remains
reachable before device enrollment, but `/v1/grants` listing and revocation
must require a valid enrolled-device cookie and expose only grants issued to
that device. Cookies remain `HttpOnly`, `Secure`, and `SameSite=Lax`; exact
Origin checks remain CSRF protection, not caller authentication.

Do not reuse the private profile's failed-passphrase counter under one shared
public principal: five anonymous failures would lock out every judge. Bound
public enrollment verification to two concurrent scrypt operations, scope five
failures to one pending authorization before invalidating only that request,
prove two independent clean browsers can enroll, and provide a fast operator
recovery path. Sustained anonymous traffic can still cause transient public
denial of service; do not disguise that residual limitation. Do not trust a
forwarded client address until Funnel's overwrite behavior is verified.

The judge passphrase belongs only in Devpost's private testing instructions. It
must not appear in Firebase assets, the public repository, screenshots, video,
logs, or runtime card. A failed or missing public-demo identity must never be
replaced with a fabricated Tailscale identity header.

## Abuse and resource containment

This environment exposes a public execution and authorization surface to an
external evaluator. Apply limits before launching an OmniGENT/ACP session:

- at most two active task streams globally;
- a 45-second task/stream timeout and 4096-byte UTF-8 prompt ceiling;
- at most 30 accepted message events, 10 session creations, and 60
  authorization requests per rolling hour across this small sandbox;
- at most two concurrent enrollment-verification operations and five failures
  per pending authorization before only that request is invalidated;
- at most 64 live pending authorization requests, 64 live authorization codes,
  and 16 managed sessions, with existing 10-minute request and 2-minute code
  expiry pruning;
- fixed Firebase Origin and fixed demonstrated tool snapshot;
- empty ephemeral workspace with no ambient plugins, MCP servers, or host data;
- no model credential or access to the developer's ChatGPT subscription;
- minimal required egress and no inbound service other than the gateway; and
- operator kill switch, grant revocation, credential rotation, and automatic
  shutdown after judging.

These controls keep the public sandbox bounded. They do not turn the
deterministic agent into evidence that the private Codex runtime is sandboxed;
the submission and UI must label the two runtime profiles honestly.

The limits may be in-memory for the hackathon sandbox and reset on restart, as
long as that behavior is documented. Do not add per-grant accounting merely to
protect a deterministic agent; it is resettable through reauthorization and is
not worth the added persistence semantics for this deployment.

On task/stream timeout or browser disconnect, abort the provider stream, send a
downstream interrupt/cancel when possible, and release concurrency capacity.
Rate accounting applies separately to authorization-request creation, session
creation, accepted validated message events, and enrollment failures; health,
challenge verification, tool results, and cancellation must not consume the
same prompt budget. Freeze exact values in configuration and tests before
exposure rather than leaving production defaults implicit.

## Implementation order

1. Push the current green repository checkpoint and deploy the latest Firebase
   Canvas.
2. Rerun and capture the existing private Serve enrollment, tool call, and
   revocation flow as the known-good fallback.
3. Implement and test the `public-demo` transport profile and hard ceilings
   without weakening the `tailscale-serve` profile.
4. Build the three-container Compose stack with separate persistent volumes,
   disposable host tmpfs, internal networks, loopback-only publishing, and the
   hardening controls above.
5. Adapt the deterministic ACP agent to select only the advertised
   `set_page_message` tool and complete the full loop on containerized loopback.
6. Enable Funnel on port 10000 and repeat the flow from a browser outside the
   tailnet.
7. Test the exact private judge instructions from a clean browser/device.
8. Record monitoring, restart, kill-switch, revocation, and August 5 teardown
   procedures.

Time-box this narrow deterministic image rather than reviving the full Codex
appliance. If Compose cannot reproduce the real OmniGENT/ACP/MCP tool loop, the
public judge deployment remains blocked until the boundary passes; do not expose
a weaker stack merely to meet the deadline, and never expose it as the normal
`dev` user.

## Validation targets

- **VAL-JUDGE-001 — public reachability:** a clean device outside the tailnet
  reaches the connector through Funnel with valid TLS and without local-network
  permission prompts.
- **VAL-JUDGE-002 — separated identity:** the judge runtime card, enrollment
  passphrase, grants, OmniGENT state, and process environment are different
  from the personal Serve connector, and no Codex credential is present.
- **VAL-JUDGE-003 — authorization:** the supplied judge credential completes
  enrollment and PKCE consent, while wrong Origin, wrong passphrase, missing
  device, replayed code, substituted connector, and revoked grant fail.
- **VAL-JUDGE-004 — real tool loop:** Firebase Canvas completes a live
  deterministic-ACP `set_page_message` request and visible page mutation
  through the Funnel URL, while the UI clearly distinguishes this sandbox from
  the recorded Codex runtime.
- **VAL-JUDGE-005 — host boundary:** direct runner access cannot see a host
  sentinel, host home, repository bind mount, Docker socket, personal connector
  state, or another session workspace; malicious shell/file/network prompts
  still produce only the fixed browser-tool behavior, and the remaining
  OmniGENT-server pivot is documented.
- **VAL-JUDGE-006 — ceilings:** concurrency, prompt, task-duration, and
  global usage/rate limits reject excess work before downstream agent launch.
- **VAL-JUDGE-007 — operations:** Compose restart/recreate, health monitoring,
  grant revocation, emergency shutdown, and a rehearsed final credential/state
  destruction procedure are proven through their real operator surfaces.

## Tailscale dependency and fallback

Funnel is currently available on all Tailscale plans, including the free
Personal plan, but remains beta and has non-configurable bandwidth limits. Its
`.ts.net` hostname and supported public ports are vendor constraints.

Agent Connect must depend only on a public HTTPS endpoint plus connector-level
identity and authorization. If Funnel pricing, limits, or availability change,
the same judge deployment can move behind another HTTPS reverse tunnel, a small
VPS, or a managed OCI ingress without changing the browser SDK or connector
identity.

## Parked demo polish

After the minimum judge path passes, the deterministic ACP agent may gain a
small, disclosed intent parser so different prompts produce visibly different
page mutations. Prefer a tiny allowlisted grammar or regex table over pretending
to implement a model. Candidate actions may be curated from real successful
Codex traces, but the UI and testing instructions must continue to call them
deterministic or pre-recorded behaviors. This polish must not delay public
reachability, authorization, limits, or the clean-browser proof.
