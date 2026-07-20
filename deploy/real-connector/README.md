# Real OmniGENT + Codex reference connector

This is the source-installable Agent Connect profile for a real, user-owned
Codex runtime. It runs the Agent Connect gateway, an OmniGENT server and host,
and a narrow compatibility wrapper around the published `codex-acp` adapter on
one Linux machine. A separate HTTPS web application can authorize through
Tailscale Serve, lend task-scoped tools, and receive real Codex tool calls.

This is distinct from the deterministic public judge appliance. The judge
appliance is the free, repeatable evaluation path; this profile is the usable
MVP and consumes the operator's own Codex access.

## Supported reference platform

The complete path has been exercised on Ubuntu 24.04 ARM64 with:

- Node.js 22 and npm 10 or newer;
- Codex CLI with a valid user login;
- OmniGENT 0.5.1;
- `@agentclientprotocol/codex-acp` 1.1.2; and
- Tailscale Serve with the browser and connector in the same tailnet.

Other Linux distributions and architectures may work but have not yet passed
the complete reference flow. Windows and macOS are not currently claimed as
supported gateway hosts. The web SDK itself is browser-safe and has no Node
runtime imports. The launcher rejects OmniGENT versions other than 0.5.1 rather
than silently applying the reviewed tool-collision policy to a different
provider inventory.

## 1. Install prerequisites

Install and authenticate Codex and Tailscale using their upstream instructions.
Install OmniGENT, then install this repository:

```sh
curl -fsSL https://omnigent.ai/install.sh | sh -s -- --version 0.5.1
git clone https://github.com/jomi-se/agent-connect.git
cd agent-connect
npm install
npm run build
```

The repository is private during Build Week. Judges must authenticate GitHub
with the access named in the submission before cloning; this command becomes
anonymous once the repository is made public.

## 2. Create a dedicated Codex runtime home

Do not point the connector at the same writable Codex home used by another
active Codex process. Authenticate a dedicated runtime home so token rotation
and runtime state remain isolated:

```sh
mkdir -p "$HOME/.agent-connect/codex-home"
chmod 700 "$HOME/.agent-connect/codex-home"
CODEX_HOME="$HOME/.agent-connect/codex-home" codex login
```

The resulting `auth.json` is a live credential. It is never copied into the
repository, runtime card, browser, or application. The operator is responsible
for securing this host and credential.

## 3. Configure the connector

```sh
cp deploy/real-connector/.env.example deploy/real-connector/.env
chmod 600 deploy/real-connector/.env
```

Edit `.env` with:

- the Tailscale Serve URL for this machine;
- the exact Tailscale login allowed to operate the connector;
- the dedicated `CODEX_HOME`;
- a dedicated session workspace directory; and
- `INITIAL_AGENT_MODE`, which defaults to `read-only`.

The reference profile enables dynamic application enrollment. A previously
unknown HTTPS Origin may begin the connector authorization flow, but that does
not grant agent access: the Tailscale requester must still be the configured
operator, the user must approve on the connector-owned page, and the resulting
grant is bound to the exact Origin, app id, redirect URI, scopes, and canonical
tool snapshot. Operational calls require that grant. The optional static Origin
allowlist remains available as a stricter deployment policy.

## Effective Codex posture and configuration

The reference launcher passes a dedicated `CODEX_HOME`, one
`AGENT_CONNECT_WORKSPACE`, and an explicit Codex ACP mode into every OmniGENT
runner. It does not inherit the interactive shell's default `~/.codex` unless
the operator deliberately points `CODEX_HOME` there.

| `INITIAL_AGENT_MODE` | Codex behavior                                                         | Recommended use                                        |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| `read-only`          | Inspect files; file edits and shell commands require approval          | Default for apps you did not write                     |
| `agent`              | `workspace-write`, sandboxed command network off, approvals on request | A dedicated disposable workspace on a host you control |
| `agent-full-access`  | No Codex filesystem/network sandbox and no approval prompts            | Do not use for arbitrary external applications         |

Codex web search is a separate built-in capability from command network access.
Choose it explicitly in the dedicated runtime home's `config.toml`:

```toml
web_search = "disabled" # no web research
# web_search = "cached" # indexed results; lower exposure and less freshness
# web_search = "live"   # current pages; useful for research, higher prompt-injection risk
```

The product-research demo profile uses `live`. A general connector should
default to `cached` or `disabled` and enable live search only when the user
accepts the additional untrusted-content boundary.

For transport and browser-tool smoke tests, use the least expensive model that
reliably follows the tool contract. The validated demo VM currently uses
`gpt-5.6-luna` with `model_reasoning_effort = "low"`; deeper reasoning is not
part of the transport proof. Model availability is account-dependent, so this
is an operator choice rather than a hard-coded Agent Connect requirement.

`AGENT_CONNECT_WORKSPACE` is the session cwd and the write boundary in `agent`
mode. It is **not a confidentiality boundary**. The Codex process and its ACP
adapter still run as the connector's Unix user on the host. Until the outer
container/OS-sandbox profile exists, assume an authorized application can try
to induce Codex to read any file that Unix user can read and return its contents
as model text or an application tool argument. Use a dedicated OS account or a
disposable VM/container when unrelated host data is in scope.

Codex settings are operator-owned under the configured runtime home:

```sh
$EDITOR "$CODEX_HOME/config.toml"
```

That file controls model and reasoning defaults, web search, MCP servers,
skills, plugins, and other normal Codex configuration. The same runtime home
may also contain sessions, memories, caches, and logs. Treat every configured
MCP, skill, plugin, absolute path, and trusted project as additional authority
available to remote tasks. Prefer a freshly created runtime home containing
only `auth.json` and a small reviewed `config.toml`; do not copy a personal
Codex home wholesale. The `.env` `CODEX_CONFIG` JSON is merged over that file
for each ACP process; the reference value uses
`approvals_reviewer: user`. The supervisor prepares a narrow compatibility
adapter around the pinned `codex-acp` bundle. For each authorized application
session, the gateway creates a fresh workspace and writes a mode-`0600` policy
manifest containing the exact granted tool names and snapshot hash. The adapter
translates that manifest into native Codex MCP `enabled_tools` and per-tool
`approval_mode = "approve"` settings. OmniGENT built-ins remain disabled, while
the already-consented browser tools do not require a second approval. Restart
`deploy/real-connector/run.sh` after changing the runtime home, workspace,
mode, or override so new downstream sessions use the reviewed configuration.

Codex `on-request` approvals are not application grants. OmniGENT handles ACP
permission requests through its own policy/elicitation path; the calling web
application cannot approve a shell, filesystem, network, or MCP escalation
through Agent Connect. This reference profile does not yet expose a polished
remote operator approval UI, so `approvals_reviewer: user` can leave a browser
tool call outside the grant-derived MCP allowlist waiting until the harness
watchdog expires. Keep the default mode narrow and preconfigure only authority
that does not require mid-task escalation. `auto_review` remains an optional
operator choice; it is not required for normal granted application tools.

## 4. Start the real connector

```sh
deploy/real-connector/run.sh
```

The command supervises the loopback OmniGENT server, OmniGENT execution host,
and Agent Connect gateway. On first state creation it prints two deliberately
separate values:

- a public runtime card that can be saved in the web application; and
- a private enrollment passphrase that is entered only on the connector-owned
  authorization page.

The durable connector identity, grants, and enrollment state live in the
gitignored `.agent-connect/real-connector` directory by default. Keep the
foreground process in tmux or replace it with an operator-managed service for
long-running use. The supervisor also gives OmniGENT a dedicated operator home
inside that state directory so its CLI logs and incidental state do not land in
the ambient user home; Codex continues to use the separately authenticated
`CODEX_HOME`.

## 5. Publish only the gateway through Tailscale Serve

With the default gateway port:

```sh
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8787
tailscale serve status
curl -fsS https://YOUR-MACHINE.YOUR-TAILNET.ts.net:8443/healthz
```

Do not expose OmniGENT or Codex directly. The configured public endpoint and
Serve URL must match exactly.

## 6. Connect a web application

Follow the [web application integration guide](../../docs/guides/web-app-integration.md).
The application imports the runtime card, verifies a fresh signed connector
challenge, redirects to connector-owned consent, exchanges the PKCE code for a
scoped grant, creates an opaque Agent Connect session, and streams the real
Codex task. Tool implementations remain in the browser.

## Security boundary

Only authorize applications you trust. The consent screen restricts which
application Origin and tool snapshot receive access; it cannot make malicious
prompts trustworthy. This reference profile is not a hardened arbitrary-app
sandbox. Codex can use the capabilities present in its dedicated runtime home
and can read files available to the connector OS user; `agent` mode limits
writes to the selected workspace. The operator owns the machine and runtime
posture. The deterministic public appliance is the safer profile for anonymous
judges because it contains no Codex credential or general agent shell.

## Recorded reference evidence

On 2026-07-20, the source-installed profile passed an isolated real-Codex
composition check on Ubuntu 24.04 ARM64:

1. the supervisor started fresh OmniGENT server and host processes plus the
   gateway with isolated operator and connector state;
2. an HTTPS application Origin absent from all startup configuration verified a
   fresh signed runtime challenge and created an authorization request;
3. connector-owned consent displayed that exact Origin and its new tool;
4. PKCE produced an Origin/app/tool-bound grant and an opaque Agent Connect
   session;
5. OmniGENT launched the compatibility-wrapped, pinned `codex-acp` adapter and
   a real Codex process;
6. Codex called the external application's unpredictable nonce tool exactly
   once, received its result, and included it in the completed turn; and
7. stopping the supervisor removed the isolated server and host processes.

A second live browser pass on the same date validated the grant-derived MCP
policy with Codex in `read-only` mode and `approvals_reviewer: user`. Codex
received exactly the ten authorized Canvas tool names through MCP
`enabled_tools`; each was individually preapproved while the server default
remained `prompt`. It read the live project board, updated existing tasks,
created missing work, moved tasks, read the resulting state, and completed the
turn. All five calls used ordinary `exec-...` action ids. No auto-review action,
downstream approval wait, or OmniGENT built-in tool appeared in the turn.

The first check injected the already-tested trusted-proxy identity header over
loopback so it could exercise the complete application/runtime path without
changing Tailscale configuration. The second pass ran from the deployed
Firebase application through Tailscale Serve and therefore completed the
combined dynamic-Origin, trusted-transport, real-Codex, and browser-tool proof.
