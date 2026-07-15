# Judge demo environment

Status: pending implementation; submission-critical

## Purpose

Provide OpenAI Build Week judges with a free, working Agent Connect environment
that does not require joining the developer's tailnet, rebuilding the project,
or receiving access to the developer's personal connector or Codex login.

The lowest-cost deployment reuses the existing VM and publishes a separate
containerized judge connector through Tailscale Funnel. Firebase continues to
host the static Canvas application. This costs no additional hosting fee on the
current Tailscale Personal plan; model usage and the VM itself remain the only
possible costs.

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

This is ample for the existing gateway, OmniGENT, Codex ACP, and Codex
composition. No new VM is required for the submission.

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
  judge connector container boundary
    Agent Connect gateway and authorization UI
    OmniGENT server, host, and runner
    codex-acp, Codex, and dynamic tool relay
    dedicated connector-state volume
    dedicated disposable agent credential
    ephemeral per-session workspaces
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
served through Tailscale Serve.

It receives its own:

- connector identity and runtime card;
- enrollment passphrase and enrolled devices;
- application grants, revocations, and audit state;
- OmniGENT state and downstream sessions;
- Codex authentication;
- container filesystem and workspace root; and
- logs and shutdown lifecycle.

The container must not mount the host home, normal `~/.codex`, application
repositories, SSH material, or container-runtime socket. The connector state
and disposable agent credential are separate mounts or secret channels; neither
belongs in an image layer or session workspace.

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
  expiry; and
- connector-owned rate, concurrency, prompt-size, task-time, and usage limits.

The judge passphrase belongs only in Devpost's private testing instructions. It
must not appear in Firebase assets, the public repository, screenshots, video,
logs, or runtime card. A failed or missing public-demo identity must never be
replaced with a fabricated Tailscale identity header.

## Abuse and cost containment

This environment lends a paid agent capability to an external evaluator. Apply
limits before launching an OmniGENT/Codex session:

- one active task per enrolled judge device;
- short task timeout and bounded prompt size;
- bounded tasks per device and per time window;
- fixed Firebase Origin and fixed demonstrated tool snapshot;
- empty ephemeral workspace with no ambient plugins, MCP servers, or host data;
- dedicated disposable API-funded Codex credential rather than the developer's
  ChatGPT subscription login;
- minimal required egress and no inbound service other than the gateway; and
- operator kill switch, grant revocation, credential rotation, and automatic
  shutdown after judging.

These controls limit expected loss; they do not prove that a model-influencing
application cannot attempt to reveal a credential visible to the agent process.
Use a low-value disposable credential and preserve that limitation in the
reported runtime posture.

## Implementation order

1. Push the current green repository checkpoint and deploy the latest Firebase
   Canvas.
2. Rerun and capture the existing private Serve enrollment, tool call, and
   revocation flow as the known-good fallback.
3. Implement and test the `public-demo` transport profile without weakening the
   `tailscale-serve` profile.
4. Build the single-appliance container with separate persistent and ephemeral
   state classes.
5. Complete the real `set_page_message` loop through the container on loopback.
6. Enable Funnel on port 10000 and repeat the flow from a browser outside the
   tailnet.
7. Test the exact private judge instructions from a clean browser/device.
8. Record monitoring, restart, kill-switch, revocation, and August 5 teardown
   procedures.

If the containerized loop has not passed by the infrastructure cutoff, keep the
same public-demo authorization design but run a dedicated copy of the proven
VM-local OmniGENT profile behind Funnel. Do not jeopardize the recorded working
demo while debugging the appliance.

## Validation targets

- **VAL-JUDGE-001 — public reachability:** a clean device outside the tailnet
  reaches the connector through Funnel with valid TLS and without local-network
  permission prompts.
- **VAL-JUDGE-002 — separated identity:** the judge runtime card, enrollment
  passphrase, grants, Codex credential, and state are different from the
  personal Serve connector.
- **VAL-JUDGE-003 — authorization:** the supplied judge credential completes
  enrollment and PKCE consent, while wrong Origin, wrong passphrase, missing
  device, replayed code, substituted connector, and revoked grant fail.
- **VAL-JUDGE-004 — real tool loop:** Firebase Canvas completes a live Codex
  `set_page_message` request and visible page mutation through the Funnel URL.
- **VAL-JUDGE-005 — host boundary:** the agent cannot see a host sentinel, host
  home, repository, Docker socket, personal connector state, or another session
  workspace.
- **VAL-JUDGE-006 — ceilings:** concurrency, prompt, task-duration, and
  per-device usage limits reject excess work before downstream agent launch.
- **VAL-JUDGE-007 — operations:** reboot recovery, health monitoring, grant
  revocation, emergency shutdown, and final credential destruction are proven
  through their real operator surfaces.

## Tailscale dependency and fallback

Funnel is currently available on all Tailscale plans, including the free
Personal plan, but remains beta and has non-configurable bandwidth limits. Its
`.ts.net` hostname and supported public ports are vendor constraints.

Agent Connect must depend only on a public HTTPS endpoint plus connector-level
identity and authorization. If Funnel pricing, limits, or availability change,
the same judge container can move behind another HTTPS reverse tunnel, a small
VPS, or a managed OCI ingress without changing the browser SDK or connector
identity.
