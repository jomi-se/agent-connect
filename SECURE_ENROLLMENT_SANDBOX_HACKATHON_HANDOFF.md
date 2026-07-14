# Agent Connect secure enrollment, sandbox, and hackathon handoff

Updated: 2026-07-14

This handoff supersedes the implementation-status portions of
`USER_OWNED_AGENT_RUNTIME_HACKATHON_HANDOFF.md`. That older file remains useful
for the original landscape research. Current architecture and policy live in
`docs/`.

## Executive state

The accountless Tailscale enrollment and application-authorization slice is
implemented in the gateway, browser SDK, and Firebase Canvas demo. It has
automated coverage but has not yet been deployed and exercised from the real
Firebase/tailnet mobile surface.

The OmniGENT VM-local outer sandbox is implemented and passed live process,
mount, seccomp, and host-sentinel checks. The complete sandboxed dynamic-tool
loop is blocked: Codex cannot initialize OmniGENT's generated MCP relay under
that boundary. More importantly, the network-capable full-access Codex process
can see the copied login credential in its dedicated home. The already-proven unsandboxed OmniGENT path remains the demo
baseline. Do not describe the sandboxed loop as passing.

The OpenAI Build Week rules, dates, criteria, announcement, and submission
fields were refreshed through the Devpost Hackathons plugin at 2026-07-14
23:35 UTC. Developer Tools remains the recommended category. Submission closes
2026-07-22 00:00 UTC.

## What changed

### Connector enrollment

`packages/gateway/src/connector-auth.ts` adds an owner-local JSON state store:

- durable Ed25519 connector identity;
- stable runtime card with endpoint, runtime id, public key, and transport
  profile;
- generated `AC-ENROLL-...` high-entropy enrollment passphrase;
- scrypt passphrase verifier; the passphrase itself is not stored;
- hashed enrolled-device cookie tokens;
- durable hashed application grant tokens and revocation state;
- durable capability-signing secret;
- owner-only directory/file modes and atomic state replacement.

On first state creation, the gateway prints a clearly separated public runtime
card and enrollment secret. Save the secret in a password manager and paste
only the public card into an app. An operator-supplied passphrase is supported for tests and
special deployments, but the normal setup should use the generated value.

### Runtime authentication before disclosure

The browser SDK's `beginAgentAuthorization` sends a fresh nonce to
`/v1/runtime-challenges` and verifies the Ed25519 response against the imported
runtime card. Only after that proof succeeds does it send tool schemas to
`/v1/authorization-requests`. A substituted URL without the enrolled private
key therefore fails before prompt/tool disclosure.

The runtime card is public routing/identity material, not an authorization
credential. The Firebase demo stores it in `localStorage`; the passphrase never
enters the application origin. The pinned Ed25519 public key is the trust
anchor; `runtimeId` is currently a connector label and must not be presented as
an independently recomputed key fingerprint.

### Application authentication and authorization

The implemented narrow profile is OAuth-style, not a claim of generic OAuth
conformance:

1. exact app Origin, app id, HTTPS same-origin redirect, scopes, PKCE challenge,
   and canonical tool snapshot are pushed to the connector;
2. the browser navigates to top-level connector `/authorize`;
3. Tailscale requester identity must match the connector allowlist;
4. an unenrolled browser enters the saved passphrase on the connector page and
   receives an HttpOnly, Secure, SameSite=Lax device cookie;
5. the user sees the app origin/id, callback, expiry, scopes, and each tool's
   declared name, description, and input schema, then approves or denies;
6. the connector redirects with transaction state and a two-minute single-use
   code;
7. the app exchanges the code with an S256 verifier for a 30-day grant;
8. the grant mints the existing short-lived opaque session capability;
9. `/v1/grants` lists and revokes grants; revocation immediately blocks an
   existing derived session capability.

Consent and revocation POSTs require the connector's exact Origin, which closes
the Tailscale-header-plus-cross-site-form CSRF path. Grants must include all
scopes the session consumes. Enabling this profile disables the old terminal
pairing flow, so pairing cannot bypass consent.

Current limitations:

- grant is bearer-only; no app-instance key or DPoP sender binding;
- pending authorization requests, codes, session mappings, and rate-limit
  counters are memory-only;
- passphrase failure limiting resets on restart;
- no device list/revoke UI, recovery, connector-key rotation, runtime-card
  re-export command, passkey, discovery metadata, RAR, or audit history;
- no incremental consent/reuse decision beyond exact grant bindings;
- Firebase keeps the grant in `sessionStorage`, appropriate only for the demo.
- no connector-enforced prompt/rate/time/token/cost ceilings yet; an authorized
  app can consume the subscription until its grant is revoked.
- the strict event allowlist validates shapes, but correlated tool-result state
  awaits the persisted pending-action broker.

### Firebase Canvas

The demo now accepts a runtime-card JSON object rather than a gateway URL and
terminal pairing code. It persists redirect transaction state, performs the
connector authorization redirect, exchanges the callback, and resumes the
pending prompt. Its dynamic `set_page_message` tool and provider-neutral
`AgentSession` behavior are unchanged.

### OmniGENT provisioning and sandbox

`OmnigentRuntime` can generate a `linux_bwrap` `os_env` profile. Required paths
are configured by environment; a host sentinel must sit outside the workspace,
Codex home, read roots, and `/tmp`. The guard script refuses launch unless the
workspace is read-only, the sentinel is hidden, `NoNewPrivs=1`, `Seccomp=2`,
and the dedicated Codex home is writable.

The verified live process had a read-only demo workspace and writable isolated
Codex home. Network remains enabled because Codex model access and the relay
need it. `/tmp` is mounted writable for OmniGENT's bridge. The dedicated Codex
home contains copied authentication/state needed to log in but intentionally
does not inherit the normal user's MCP/plugin configuration.

That copied `auth.json` is visible to Codex running in `agent-full-access` while
network is enabled. A malicious application prompt could therefore attempt to
exfiltrate the login. The outer boundary is useful host-isolation evidence, but
it is not a safe malicious-application sandbox until credentials are brokered
outside the agent-visible process or the entire runner uses short-lived
credentials and controlled egress.

The compatibility failure is fully documented in
`docs/research/2026-07-14-omnigent-vm-sandbox-spike.md`. The key evidence is:

- outer boundary probes pass;
- request-scoped tools reach OmniGENT and a relay directory is created;
- Codex app-server reports the `omnigent` MCP initialize connection closed;
- in read-only Codex mode, nested command execution fails because OmniGENT's
  seccomp denies creation of another namespace;
- using `agent-full-access` inside the already-contained outer boundary removes
  the nested turn sandbox but did not fix the MCP child handshake;
- the same generated `serve-mcp` command answers initialize outside Codex's MCP
  launcher.

The next diagnostic is to wrap or patch the generated MCP command so its exact
stderr is captured. The likely production-quality alternative is a disposable
container/VM around the entire runner, avoiding nested user namespaces.

## Validation evidence

Automated tests presently cover:

- connector state creation/reload;
- signed runtime challenge and invalid-signature no-disclosure behavior;
- exact redirect validation and callback state binding;
- enrollment passphrase success/failure;
- connector consent CSRF and grant-revocation CSRF;
- S256 PKCE failure and authorization-code replay;
- denial and state substitution;
- grant/tool/origin/app/scope binding;
- incomplete-scope and changed-tool rejection;
- strict message/tool-result/interrupt event schemas and unknown-event rejection;
- durable revocation and immediate rejection of an existing capability;
- disabled legacy pairing bypass;
- sandbox bundle generation and invalid path/sentinel rejection;
- Firebase Canvas existing-grant browser flow.

Final local gate on 2026-07-14:

- `npm run verify`: passed formatting, typecheck, 15 gateway tests, 21 web SDK
  tests, and all workspace builds;
- `npm run test:e2e --workspace @agent-connect/firebase-canvas`: 1/1 passed.

The Playwright test uses a mocked gateway and preloaded grant. It proves the
browser tool/mutation path, not live connector challenge, passphrase, redirect,
PKCE, or revocation. Those remain part of the deployed phone validation.

## Independent review disposition

Two independent review lanes checked submission coherence and the security
boundary. Their implementation findings were resolved as follows:

- the Firebase app no longer overwrites its durable grant with a short-lived
  session capability;
- callback URL/state is checked before handling both success and denial;
- the public SDK no longer advertises arbitrary scope subsets, and the gateway
  rejects incomplete sets;
- unknown/approval-like provider events now fail a strict schema allowlist;
- public endpoint configuration is canonicalized to one HTTPS origin;
- the consent page now shows callback, expiry, scopes, and tool declaration
  details;
- changed tool metadata, incomplete scopes, forged denial state, unexpected
  callback URL, and unknown event shapes have negative coverage;
- first-run output separates the public runtime card from the enrollment
  secret; and
- hackathon planning now uses Canvas rather than unfinished spreadsheet
  durability as the canonical demo.

Review findings intentionally left open are not cosmetic: connector resource
ceilings, persisted/correlated pending actions, sender-bound grants, runtime-card
re-export/recovery, real deployed mobile coverage, and safe credential isolation
for a malicious-app runtime.

## Local ignored setup

The live sandbox experiment created ignored files under `.omnigent-spike/`:

- `config.yaml` using the guard;
- `demo-workspace/`;
- `demo-codex-home/` with dedicated config/auth/state;
- logs and OmniGENT data.

A sentinel was created outside the repository at:

```text
/home/dev/agent-connect-sandbox-host-sentinel
```

Never commit the ignored Codex home, auth file, connector state, enrollment
bundle, device token, grant, app-server log, or raw trace.

The reusable tracked example is `config/omnigent-demo.yaml.example`; the guard
is `scripts/omnigent-codex-sandbox-guard.sh`.

## Deployment variables

The enrolled gateway needs at least:

```sh
AGENT_CONNECT_HOST=127.0.0.1
AGENT_CONNECT_PORT=8787
OMNIGENT_URL=http://127.0.0.1:6767
AGENT_CONNECT_WORKSPACE=/absolute/agent/workspace
AGENT_CONNECT_ALLOWED_ORIGINS=https://agent-connect-demo.web.app
AGENT_CONNECT_ALLOWED_TAILSCALE_USERS=owner@example.com
AGENT_CONNECT_STATE_PATH=/owner-only/agent-connect-state.json
AGENT_CONNECT_PUBLIC_ENDPOINT=https://MACHINE.TAILNET.ts.net:8443
AGENT_CONNECT_TRANSPORT_PROFILE=tailscale-serve
```

Do not configure `AGENT_CONNECT_PAIRING_CODE` in this profile. Do not put the
enrollment passphrase in Firebase or application environment variables.

For the experimental sandbox, also configure the gateway:

```sh
AGENT_CONNECT_OMNIGENT_SANDBOX=linux_bwrap
AGENT_CONNECT_SANDBOX_CODEX_HOME=/absolute/dedicated-codex-home
AGENT_CONNECT_SANDBOX_HOST_SENTINEL=/absolute/outside-mounted-roots
AGENT_CONNECT_SANDBOX_READ_PATHS=/absolute/codex-acp-dist,/absolute/codex-vendor,/absolute/guard-parent
```

The OmniGENT host process must separately be started with the same dedicated
home and its host-side sentinel path, for example:

```sh
CODEX_HOME=/absolute/dedicated-codex-home \
AGENT_CONNECT_HOST_SENTINEL=/absolute/outside-mounted-roots \
omnigent host start
```

Use the proven non-sandboxed profile for the public demo until the MCP issue is
closed.

## Submission refresh and plan

The live Devpost submission requires:

- a working project built with Codex and GPT-5.6;
- one category (`Developer Tools` recommended);
- description and repository URL;
- public narrated YouTube demo under three minutes;
- `/feedback` ID from the primary Codex build session;
- public repo plus relevant license, or private access for both judging
  addresses;
- README setup/sample/test instructions and explicit Codex/GPT-5.6 story;
- installation, supported-platform, and no-rebuild judge test instructions for
  a developer tool.

Live field IDs and dates are in
`docs/research/2026-07-14-openai-build-week-refresh.md`. The primary session
candidate remains `019f5c47-a462-73d0-a329-39013786bae4`; `/feedback` still has
to be run inside it.

Recommended critical path:

1. run the full repo gate and resolve independent review findings;
2. deploy the enrolled gateway and updated Firebase app;
3. validate first-device enrollment, approval, tool execution, second use,
   denial, and revocation on the phone;
4. capture clean screenshots/traces with identifiers and secrets redacted;
5. freeze the Canvas demo unless spreadsheet durability is genuinely done;
6. add LICENSE, supported platforms, judge path, and submission README content;
7. provide a judge-accessible path that cannot silently consume the owner's
   subscription—likely a pre-recorded proof plus deterministic mock/test mode,
   or a separately controlled temporary runtime;
8. obtain `/feedback`, record the narrated video, recheck Devpost data, and
   submit before 2026-07-22 00:00 UTC.

## Commands for the next agent

```sh
git status --short
npm install
npm run verify
npm run test:e2e --workspace @agent-connect/firebase-canvas
```

Then inspect:

```text
docs/plan/secure-enrollment-implementation.md
docs/research/2026-07-14-omnigent-vm-sandbox-spike.md
docs/research/2026-07-14-openai-build-week-refresh.md
docs/plan/openai-build-week-submission.md
```

Do not generalize to multi-agent orchestration, stable MCP-over-ACP, or a second
proprietary provider before the deployed authorization demo and durability
boundary are honest and reproducible.
