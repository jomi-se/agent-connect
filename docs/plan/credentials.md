# Plan: harness credentials for boxed sessions

Status: dedicated shared-home direction implemented; hosted owner authorization updated 2026-10-03, unreleased. It addresses the credential-boundary
prerequisite of [ADR 0016](../decisions/0016-acp-application-boundary.md). It
follows the [ACP gateway spike](../archive/experiments/acp-gateway.md), whose boxed runs
used only a mock model.

## Problem

A boxed session runs the owner's harness against the owner's subscription.
The spike left four constraints open:

- the owner's own login must not be copied, changed or logged out;
- refresh-token rotation must keep working when several boxes run at once;
- the setup must be simple enough for an owner to do once;
- the harness's own shell can read whatever credential the harness can read.

## Direction

The owner creates a **dedicated Agent Connect login**, once per harness, in an
Agent Connect directory on the host. Every box mounts that directory
read-write as its home. This is a common way to run Claude Code in containers.

- **Separate refresh chain.** The dedicated login is a separate OAuth
  session, so it never rotates or revokes the owner's personal sessions.
- **Shared, not copied.** Boxes mount the same directory, the way several
  harness processes on one machine share one credential file. A copy would
  fork the refresh chain.
- **Revocable.** The owner can revoke the dedicated login without touching
  their main account.
- **One home per harness.** Sessions share configuration and transcripts.
  Separating credentials from data is investigated (below) but is not
  required.

### Accepted risk

When the owner uses a harness, the owner writes the prompts. Here, a consented
application sends prompts and offers tools. A harness tricked into reading its
own credential could pass it to that application as a tool argument. The
egress proxy cannot block this, because application tools are an allowed path.

The risk is accepted, with these bounds:

- the credential is a dedicated login, revocable on its own;
- each application needs owner consent;
- the documentation states the worst case: a consented application could
  obtain this login.

A credential-injecting egress proxy remains a later hardening option.

A shared home also lets one application's sessions read another
application's transcripts through the harness. That is a known limitation of
this direction.

## Gateway owner authentication and application consent (2026-10-03)

Guided `agent-connect setup` orchestrates private owner initialization, the
existing owner-run harness login helper, owned egress and user-service installation
and start. Persistent setup choices include the configured gateway entry points,
offered restricted profiles and default permission profile. Explicit
`setup --upgrade` updates the release image and owned service executable without
replacing private owner state, grants, journals or dedicated login homes. Changed
image or harness policy invalidates grants and requires application reapproval.
Unattended setup never starts provider login. Owner credential presence is
checked through metadata by `doctor`; validity remains an owner-run live check.
Lost gateway TOTP is recovered with `agent-connect reset-totp` after stopping
the gateway. The exclusive state lock prevents concurrent reset; passphrase and
grant records remain intact, and bounded recovery metadata records the reset.
There is no app-grant or remote factor-reset authority.

Normal setup now creates gateway-owned sign-in and authorization state, separate
from the dedicated provider login. `agent-connect init` prompts for a hidden
owner passphrase of at least 12 characters and confirmation, only at a terminal:
no file, argument or environment input exists, so agents cannot create or read
the owner credential. `reset-passphrase` replaces it offline. An Argon2 passphrase hash,
optional TOTP secret and grant state live under the runtime's private
`state/auth` directory, outside the harness home and application access.
The owner passphrase is not an application bearer and is never sent to a box.

The gateway hosts owner sign-in, optional TOTP enrollment and a consent page
showing the exact requesting application origin, full fixed tools, native boxed
harness authority, supported restricted profiles and access duration. The selected
profile is immutable grant authority. Enrolled TOTP is required at login and
again with a fresh code for each approval. Owner sessions use a separate
HttpOnly, SameSite=Lax cookie, Secure on HTTPS. Owner forms use CSRF protection;
CSP and frame headers prevent embedding the approval UI in an application.
Provider device login still uses `agent-connect login`; owner sign-in does not
log in to the provider, modify personal credentials or alter accepted home risks.

Apps begin popup or redirect consent through an explicit user action. Requests
expire after ten minutes; PKCE authorization codes after two minutes; application
access tokens after five minutes. The owner selects 1 hour (default), 1 day,
7 days or 30 days, bounding the grant and rotating refresh chain. Each grant has
a stable ID, exact app origin, fixed tools and a gateway policy fingerprint.
Changing operator policy invalidates its grants. Refresh rotation detaches and
reconnects transport without changing ownership or replaying a prompt.
Refresh-token reuse revokes the grant; uncertain rotation is not automatically
retried. SDK default resume only reuses/completes a grant and never opens consent.

The hosted owner console can end a live session without revoking its grant,
revoke one or all grants and forget its owner browser session. Active and detached
revoked authority ends within one second, and per-frame
checks prevent forwarding newly unauthorized effects. Revocation cannot undo
completed effects. App consent renewal requires another explicit Connect action;
provider-login revocation remains a separate provider-account action affecting
only the dedicated login. Optional TOTP adds protection to owner login and new
approvals; a stolen active application token remains authority until expiry or
revocation. This design does not require a code for every harness session.

The HTTPS `public_url` and explicitly configured entry-point origins serve owner
pages, OAuth metadata/endpoints and the `/acp` socket. A grant is bound to the
exact entry point used for pairing, including its issuer and socket authority.
Owner cookies and CSRF checks are origin-specific; cross-entry-point owner
requests are rejected. Proxies preserve the public Host, browser Origin and
WebSocket subprotocol headers. HTTP loopback is permitted locally. Normal setup issues no grant
file. The explicit `--headless-static-bearer` mode retains manual origin/tool
approval for headless integrations without owner pages or managed refresh.
These changes do not establish live pairing or provider-refresh acceptance;
new checks and owner-run live evidence remain separate release gates.

### Mobile owner approval follow-up

A dedicated mobile approval client remains unimplemented. Its first design pass
should define separate device pairing under gateway owner authentication, a
revocable device credential outside the harness and app grant state, and a
bounded approval request bound to a specific origin, tool snapshot, duration and
grant. Notifications should reveal enough to identify the request without
exposing app content; rate limits, denial, expiry and replay protection must
apply before an approval can issue authority. Define recovery after device loss
and revocation of both device access and application grants before shipping.

Transport reattachment and refresh within an existing approval should preserve
its fixed authority. Any proposal to require device approval for a new harness
session or sensitive operation needs a separate decision and explicit SDK
behavior. Current mobile support is browser redirect consent with gateway-owned
TOTP, not a native mobile approval app. The accepted ability of a consented
harness to read its own dedicated provider credential and shared transcripts
remains unchanged.

## Provider terms come first (researched 2026-10-01)

Interactive versus non-interactive use is not the line that matters. The
provider's terms are.

**Anthropic.** The Claude Code legal page ("Authentication and credential
use") says:

- subscription OAuth "is designed to support ordinary use of Claude Code and
  other native Anthropic applications";
- developers of "products or services that interact with Claude's
  capabilities, including those using the Agent SDK, should use API key
  authentication";
- Anthropic "does not permit third-party developers to offer Claude.ai login
  into their own applications, or to route requests through Free, Pro, or Max
  plan credentials on behalf of their users";
- developers "may not collect, store, or intermediate Claude.ai credentials or
  session tokens".

It also says this does not prevent "an end user from signing in to the
unmodified Claude Code binary with their own Claude subscription". The Agent
SDK overview adds: "Unless previously approved, Anthropic does not allow third
party developers to offer claude.ai login or rate limits for their products".

Agent Connect matches some of the permitted pattern:

- the owner runs the gateway;
- the owner signs in to unmodified Claude Code through Anthropic's own flow;
- Agent Connect never reads the credential;
- usage is billed to the owner's own plan.

It also resembles the prohibited one. A third-party application sends prompts
through the owner's subscription, and `claude-agent-acp` is built on the Agent
SDK. Whether this is permitted is a question for Anthropic, not something this
plan can settle. Until Anthropic answers:

- Claude Code behind Agent Connect is labeled as unconfirmed against
  Anthropic's terms;
- this implementation does not pass API-key variables into boxes;
- Agent Connect asks Anthropic, through the contact route named on that page.

**OpenAI.** OpenAI publicly supports ChatGPT-plan use in third-party tools,
and offers "Sign in with ChatGPT" for third-party developer tools. Its terms
neither explicitly permit nor prohibit it. Codex is the lower-risk first
harness for a live release.

## Findings (researched 2026-10-01)

**Claude Code: credentials can be separated natively.**

- `claude setup-token` (Claude Code 2.1.286) is described as "Set up a
  long-lived authentication token (requires Claude subscription)".
- The authentication documentation says: "This token authenticates with your
  Claude subscription and requires a Pro, Max, Team, or Enterprise plan." So
  it uses subscription allowance, not API billing.
- The token is valid for one year, and Claude Code does not refresh it. It is
  printed once and read from `CLAUDE_CODE_OAUTH_TOKEN`. It keeps the credential
  out of the home directory.
- It is documented for "CI pipelines and scripts where browser login isn't
  available". Agent Connect is interactive use through another client, and
  the owner must copy the printed token into Agent Connect. That sits closer
  to the "collect, store" wording than a `/login` inside the box. The
  default is therefore `/login` in the shared home. The token is only
  compared in the spike.
- Limits:
  - it can only make model requests (no Remote Control or claude.ai
    integrations), which the gateway does not need;
  - `--bare` mode does not read it;
  - an environment variable is as readable to the harness's shell as a file,
    so the accepted risk is unchanged.
- In the credential precedence order, it outranks a `/login` credential and
  ranks below `ANTHROPIC_API_KEY`. The gateway must not pass any API key
  variable into a box.
- Without the token, the Linux login lives in `.credentials.json` under
  `CLAUDE_CONFIG_DIR` (default `~/.claude`), next to the data.

**Codex: no native separation for ChatGPT plans.**

- A ChatGPT-plan login is cached in `auth.json` under `CODEX_HOME`, or in an
  OS keyring. `cli_auth_credentials_store` selects `file`, `keyring`, `auto`
  or `ephemeral`. None of them puts the file outside `CODEX_HOME`, and boxes
  have no keyring.
- Codex refreshes ChatGPT tokens automatically during use, so the file must
  be writable and shared.
- `CODEX_ACCESS_TOKEN` and `codex login --with-access-token` are for ChatGPT
  Enterprise workspaces only. API keys are billed through the API.
- The dedicated home therefore holds both credentials and data.

## Spike

1. **Gateway option `--harness-home <dir>`.** It bind-mounts a host directory
   as the box home for every session, in place of the per-session tmpfs or
   the per-grant volume.
2. **One-time login helper.** It runs the box interactively with
   that directory mounted:
   - for Claude Code, `/login` (with a pasted code), and separately
     `claude setup-token`;
   - for Codex, `codex login --device-auth`.

   The owner runs it; Agent Connect never sees the login.

3. **Live checks, on a deterministic prompt, with each harness:**
   - one boxed turn on the dedicated login;
   - the owner's personal login still works afterwards;
   - revoking the dedicated login stops boxed turns with a clear error.
4. **Claude Code token variant:** `CLAUDE_CODE_OAUTH_TOKEN` passed into the
   box with a per-session or per-grant home. Check `/status`, or the request
   headers through the egress proxy, to confirm that it is a subscription
   credential.
5. **Bind-mount details:** the host UID against the image's `node` user (UID
   1000), and file modes on the shared directory.

Each live check spends a small amount of subscription allowance, so the owner
starts it. Results go to `docs/archive/experiments/acp-gateway.md`.

## Kill criteria

- A refresh inside a box invalidates the owner's personal login.

## Implementation (2026-10-02, unreleased)

The product binary implements `serve --harness-home <dir>` and
`login --harness codex --harness-home <dir>`. The owner chooses an absolute,
dedicated directory. The helper creates it with mode 0700, rejects symlinks,
wrong ownership and permissive modes, and mounts the same directory read-write
at `/home/node` in every session. The container runs as the invoking host UID
and GID, including when these differ from the image's node UID 1000. No chown
of personal files, credential copies, or credential/data separation occurs.
The entrypoint uses umask 077; Codex uses a file credential store in the shared
home. Existing private files stay in place. Container launch has an explicit
environment allowlist; no API-key variables are forwarded.

After the local box is built, the owner runs one command:

```sh
agent-connect login
```

The terminal selector defaults to Codex and labels Claude Code as unconfirmed.
Login, new init and production serve use a dedicated per-harness home under
`$HOME/.local/state/agent-connect/harnesses/` on Linux or
`$HOME/Library/Application Support/agent-connect/harnesses/` on macOS.
An absolute `XDG_STATE_HOME` overrides the platform root. Explicit home overrides
and existing private config homes remain supported; no personal provider home
is discovered or copied. `login --config <file>` selects from an existing runtime,
and refuses a harness mismatch before creating a home or invoking Docker.
Selecting Codex invokes `codex login --device-auth` interactively inside the image.
`login --harness claude` invokes `claude /login`, with the same mount. Claude
Code remains **unconfirmed against Anthropic terms**. `claude setup-token`
remains a compared variant only; the gateway does not collect or forward that
token. Dedicated homes include configuration and transcripts as well as the
login: a consented application could read the dedicated credential and another
application's transcripts, and could alter shared harness configuration.

Command-contract tests use a disposable Docker stand-in; they never log in.
On 2026-10-03, the owner reported a successful dedicated Codex device login
and a subscription-backed sample chat that completed `read_passage` and returned
the chapter text. This establishes the basic live login/application-tool path
for this candidate, based on the owner's report rather than automated evidence.
Personal-login coexistence and scoped revocation require separate owner-run
checks. Claude subscription
use remains unconfirmed against Anthropic terms. Deterministic implementation
checks spent no allowance; the owner initiated the live turn.

## Shared-home concurrency

Provider credential refresh is separate from application-grant refresh. Every
box mounts the same read-write dedicated harness home, including provider
credentials and conversations. This follows the harness's normal local
multi-process behavior on the same host. The default capacity is **32 session
boxes** (`max_sessions: 32`); shared-home concurrency is not a release gate.
There is no refresh broker. Investigate a refresh problem if one is observed
in real use rather than limiting capacity for an unobserved theoretical race.
The accepted risk that the harness reads its own auth file remains unchanged.
Owner authorization state and TOTP secrets are never in this mount.
