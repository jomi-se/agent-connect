# Judge demo environment

Status: public Funnel/browser happy path proven; revocation and final judge-instruction rehearsal pending

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

This is ample for one disposable container containing the gateway, OmniGENT,
and deterministic ACP composition. No new VM or model credential is required
for the judge sandbox.

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
127.0.0.1:10081
  Agent Connect judge appliance container
      Agent Connect API and authorization UI
      dedicated connector-state volume
      OmniGENT server and host
      deterministic ACP agent and request-scoped MCP relay
      disposable tmpfs home, temp, and workspace
```

The eventual exposure command is expected to have this shape after the judge
gateway passes loopback validation:

```sh
sudo tailscale funnel --bg --https=10000 http://127.0.0.1:10081
```

The local target is `http://127.0.0.1:10081`. Do not run this command until the
public-demo authorization profile and full tool loop pass locally. `--bg` makes
the Funnel configuration resume after a
Tailscale or host restart. Capture `tailscale funnel status --json` as deployment
evidence.

## Isolation from the personal connector

The judge deployment must not reuse or expose the private connector currently
served through Tailscale Serve. The deterministic ACP agent intentionally has
no model, filesystem tool, ambient MCP authority, or prompt-to-process path,
but it must spawn OmniGENT's request-scoped MCP relay. A parser, dependency, or
protocol-handler RCE would therefore be serious if the stack ran as the VM's
normal `dev` user. The minimum public profile puts the complete deterministic
stack in one disposable appliance container rather than relying only on
application-level tool restrictions.

It receives its own:

- connector identity and runtime card;
- enrollment passphrase and enrolled devices;
- application grants, revocations, and audit state;
- OmniGENT state and downstream sessions;
- no Codex or model authentication at all;
- isolated container state and workspace root; and
- logs and shutdown lifecycle.

Run the appliance as a non-root user with a read-only root filesystem,
default seccomp, all Linux capabilities dropped, `no-new-privileges`, bounded
PIDs/CPU/memory, and writable tmpfs only where required. Do not mount the host
home, repository, normal `~/.codex`, SSH material, or Docker socket. Persist
only the disposable judge connector and OmniGENT state required across a
restart. Publish only the gateway port, bound to host loopback for Funnel.

This boundary protects the VM and personal connector from an ordinary
application or dependency compromise. It deliberately does not isolate the
gateway, OmniGENT server, and deterministic runner from one another: compromise
of any process may compromise the disposable judge appliance. That is an
accepted hackathon risk because the appliance contains no personal data,
Codex/model credential, shell tool, or host mount. Separate service/runner
containers remain a possible production hardening step, not a minimum-demo
requirement. This is not a TEE or a claim that kernel/container escapes are
impossible.

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
- the existing request-size and protocol bounds, plus Docker-level
  CPU/memory/PID limits.

`public-demo` uses an internal public-demo device principal; it must not invent
or accept a fake Tailscale user identity. The authorization page remains
reachable before device enrollment, but `/v1/grants` listing and revocation
must require a valid enrolled-device cookie. Cookies remain `HttpOnly`,
`Secure`, and `SameSite=Lax`; exact Origin checks remain CSRF protection, not
caller authentication. Device-scoped grant ownership is desirable but does not
gate the first public demo.

Cookies are hostname-scoped, not port-scoped. The private Serve connector and
public Funnel profile currently share one `.ts.net` hostname on different
ports, so a browser that has used the private connector may send its private
device cookie to the public appliance. Separate server-side state means that
token will not authenticate there, but its transmission weakens the isolation
claim. Require a clean or incognito browser profile for the public demo and do
not reuse the owner's private-connector browser. A distinct public hostname is
the durable fix after the hackathon; changing only the cookie name does not
prevent the old cookie from being sent.

The judge passphrase belongs only in Devpost's private testing instructions. It
must not appear in Firebase assets, the public repository, screenshots, video,
logs, or runtime card. A failed or missing public-demo identity must never be
replaced with a fabricated Tailscale identity header.

## Minimum abuse and resource containment

This environment exposes a public execution and authorization surface, but the
minimum profile is deliberately narrow: fixed Firebase authority, fixed tool
snapshot, no model credential, an empty disposable workspace, no host mounts,
one loopback-published service, and Docker CPU/memory/PID bounds. Existing API
request-size and protocol bounds remain in force. The operator kill switch is
`tailscale funnel off` plus stopping the appliance.

Do not add a matrix of rolling request, session, authorization, concurrency,
and passphrase-verification counters before the happy path works. That logic is
easy to make internally inconsistent and could lock judges out. After the
public flow is stable, design one small coherent usage policy instead of many
independent ceilings. Candidate controls include a task timeout, active-task
cap, prompt-size cap, bounded pending state, and a coarse global request budget.
Device-scoped grants and shared-passphrase denial-of-service resistance belong
to the same security-polish pass.

These controls do not turn the deterministic agent into evidence that the
private Codex runtime is sandboxed; the submission and UI must label the two
runtime profiles honestly.

## Implementation order

1. Push the current green repository checkpoint and deploy the latest Firebase
   Canvas.
2. Rerun and capture the existing private Serve enrollment, tool call, and
   revocation flow as the known-good fallback.
3. Implement and test the narrow `public-demo` transport profile without
   weakening the `tailscale-serve` profile.
4. Build the one-container judge appliance with isolated state, disposable
   tmpfs, loopback-only publishing, and the baseline hardening controls above.
5. Adapt the deterministic ACP agent to select only the advertised
   `set_page_message` tool and complete the full loop on containerized loopback.
6. Enable Funnel on port 10000 and repeat the flow from a browser outside the
   tailnet.
7. Test the exact private judge instructions from a clean browser/device.
8. Record the start, logs, stop, Funnel kill-switch, and August 5 teardown
   commands.

Steps 3–5 passed on containerized loopback on 2026-07-17. The reusable smoke
client completed enrollment, PKCE exchange, OmniGENT provisioning, ACP startup,
request-scoped MCP `set_page_message`, browser result, and turn completion.
Step 6 and the happy-path portion of step 7 passed on 2026-07-18 from a clean
external mobile browser. The public Firebase Canvas verified the connector,
redirected to the Funnel-hosted consent page, completed enrollment and PKCE,
created an OmniGENT session, executed `set_page_message` exactly once, returned
the correlated browser-tool result, and visibly replaced the page message. No
local-network permission prompt was required. The remaining rehearsal work is
the grant-list/revocation path and a final pass over the exact private judge
instructions.

Time-box this narrow deterministic image rather than reviving the full Codex
appliance. If Compose cannot reproduce the real OmniGENT/ACP/MCP tool loop, the
public judge deployment remains blocked until the boundary passes; do not expose
a weaker stack merely to meet the deadline, and never expose it as the normal
`dev` user.

## Validation targets

- **VAL-JUDGE-001 — public reachability:** a clean device outside the tailnet
  reaches the connector through Funnel with valid TLS and without local-network
  permission prompts.
- **VAL-JUDGE-002 — disposable appliance:** the judge runtime card, enrollment
  passphrase, grants, OmniGENT state, and process environment are different
  from the personal Serve connector; no Codex credential or sensitive host
  mount is present; and the sole published port is bound to loopback.
- **VAL-JUDGE-003 — authorization:** the supplied judge credential completes
  enrollment and PKCE consent. The fixed Firebase app/tool authority is
  enforced, `/v1/grants` requires the enrolled-device cookie, and a small set
  of auth-focused negative API tests fail closed.
- **VAL-JUDGE-004 — real tool loop:** Firebase Canvas completes a live
  deterministic-ACP fixture `set_page_message` request and visible page mutation
  through the Funnel URL, while the UI clearly distinguishes this sandbox from
  the recorded Codex runtime.

The hackathon gate is these four targets. Exhaustive prompt-adversary,
mount/capability/network/sentinel, restart-persistence, secret-layer, teardown,
and rate-limit automation is deferred. In particular, asking a deterministic
fixture for a malicious shell action and observing its fixed tool call would
not prove shell isolation; it would be a misleading test. Use a short manual
`docker inspect` and mount/environment checklist before exposure, then invest
in deeper security tests only after the public happy path is reliable.

## Public validation evidence — 2026-07-18

- Tailscale Funnel reported HTTPS port `10000`, the loopback proxy to
  `127.0.0.1:10081`, and `AllowFunnel: true`.
- The public TLS health endpoint returned `{"ok":true}`.
- A public-origin protocol probe returned the exact Firebase CORS origin and
  rejected a missing challenge nonce with `400 invalid_request`.
- The container remained healthy and created a fresh OmniGENT runner/session
  for the external browser task.
- The external mobile browser displayed the configured deterministic message
  and a tool result reporting `displayed: true` and `writes: 1`.

This proves VAL-JUDGE-001 and VAL-JUDGE-004 for the deterministic public profile
and exercises the positive path of VAL-JUDGE-003. The negative authorization
cases remain covered by the gateway behavior suite. It does not prove the
private Codex runtime has the same sandbox posture or that Funnel itself is an
Agent Connect security boundary.

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
reachability, authorization, or the clean-browser proof.
