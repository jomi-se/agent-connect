# Real OmniGENT + Codex reference gateway

This is the source-installable Agent Connect profile for a real, user-owned
Codex agent. It runs the Agent Connect gateway, an OmniGENT server and host,
and a small compatibility wrapper around the published `codex-acp` adapter on
one Linux machine. A separate HTTPS web application can authorize through
Tailscale Serve, lend task-scoped tools, and receive real Codex tool calls.

This is distinct from the deterministic public judge demo. This profile is the
usable MVP and uses the user's own Codex account.

## Supported reference platform

The complete path has been tested on Ubuntu 24.04 ARM64 with:

- Node.js 22 and npm 10 or newer;
- Codex CLI with a valid subscription account already logged in through OAuth;
- OmniGENT 0.5.1;
- `@agentclientprotocol/codex-acp` 1.1.2; and
- Tailscale Serve with the browser and gateway in the same tailnet.

Other Linux distributions and architectures may work but have not yet been
fully tested. Windows and macOS have not been tested. The launcher rejects
OmniGENT versions other than 0.5.1 in case upstream changes would break Agent
Connect.

## 1. Install prerequisites

Install and authenticate _Codex_ and _Tailscale_ using their upstream instructions.
Install OmniGENT, then install this repository:

```sh
curl -fsSL https://omnigent.ai/install.sh | sh -s -- --version 0.5.1
git clone https://github.com/jomi-se/agent-connect.git
cd agent-connect
npm install
npm run build
```

## 2. Create a dedicated Codex runtime home

This is not mandatory, but avoid pointing the gateway at the same writable
Codex home used by other Codex processes. Authenticate a dedicated runtime home
so token rotation and runtime state remain isolated:

```sh
mkdir -p "$HOME/.agent-connect/codex-home"
chmod 700 "$HOME/.agent-connect/codex-home"
CODEX_HOME="$HOME/.agent-connect/codex-home" codex login
```

OmniGENT will use the resulting `auth.json` as a live credential.

## 3. Configure the gateway

```sh
cp deploy/real-gateway/.env.example deploy/real-gateway/.env
chmod 600 deploy/real-gateway/.env
```

Edit `.env` with:

- the Tailscale Serve URL for this machine;
- the exact Tailscale login allowed to operate the gateway;
- the dedicated `CODEX_HOME`;
- a dedicated session workspace directory; and
- `INITIAL_AGENT_MODE`, which defaults to `read-only`.

## Codex configuration

The reference launcher passes a dedicated `CODEX_HOME`, one
`AGENT_CONNECT_WORKSPACE`, and an explicit Codex ACP mode into every OmniGENT
runner. It does not inherit the interactive shell's default `~/.codex` unless
the user deliberately points `CODEX_HOME` there.

| `INITIAL_AGENT_MODE` | Codex behavior                                                         | Recommended use                                        |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| `read-only`          | Inspect files; file edits and shell commands require approval          | Default for apps you did not write                     |
| `agent`              | `workspace-write`, sandboxed command network off, approvals on request | A dedicated disposable workspace on a host you control |
| `agent-full-access`  | No Codex filesystem/network sandbox and no approval prompts            | Do not use for arbitrary external applications         |

Consider setting up the codex web search setting in the dedicated runtime home's `config.toml`:

```toml
web_search = "disabled" # no web research
# web_search = "cached" # indexed results; lower exposure and less freshness
# web_search = "live"   # current pages; useful for research, higher prompt-injection risk
```

The product-research demo profile uses `live`. A general gateway should
default to `cached` or `disabled` and enable live search only when the user
accepts the additional untrusted-content boundary.

`AGENT_CONNECT_WORKSPACE` is the session cwd and the write boundary in `agent`
mode. However, keep in mind it is **not a sandbox boundary**. The Codex process
and its ACP adapter still run as the gateway's Unix user on the host. Use a
dedicated OS account or a disposable VM/container when unrelated host data is
in scope.

Codex settings are user-owned under the configured runtime home:

```sh
$EDITOR "$CODEX_HOME/config.toml"
```

That file controls model and reasoning defaults, web search, MCP servers,
skills, plugins, and other normal Codex configuration. The same runtime home
may also contain sessions, memories, caches, and logs. Treat every configured
MCP, skill, plugin, absolute path, and trusted project as additional authority
available to remote tasks. Prefer a freshly created runtime home containing
only `auth.json` and a small reviewed `config.toml`. The `.env` `CODEX_CONFIG`
JSON is merged over that file for each ACP process.

In this MVP, the calling web application cannot yet approve Codex tool requests
through Agent Connect.

## 4. Start the real gateway

```sh
deploy/real-gateway/run.sh
```

This command starts and supervises all downstream actors: the Agent Connect
gateway, the OmniGENT server, and the OmniGENT execution host. On first state
creation it prints two deliberately separate values:

- a public runtime card: this is how a web app knows how to target and verify an
  Agent Connect gateway. Enter it in the web app using the Agent Connect SDK;
  and
- a private enrollment passphrase: this secret is requested during
  authorization after redirecting to a gateway-owned page served by the Agent
  Connect gateway itself.

The durable gateway identity, grants, and enrollment state live in the
gitignored `.agent-connect/real-connector` directory by default. This legacy
internal directory name is retained for compatibility. Keep the
foreground process in tmux/screen or replace it with a user-managed service for
long-running use. The supervisor also gives OmniGENT a dedicated home
inside that state directory. Codex continues to use the separately authenticated
`CODEX_HOME`.

## 5. Publish the gateway through Tailscale Serve

Using the default gateway port:

```sh
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8787
tailscale serve status
curl -fsS https://YOUR-MACHINE.YOUR-TAILNET.ts.net:8443/healthz
```

## 6. Connect a web application

Follow the [web application integration guide](../../docs/guides/web-app-integration.md).
The application imports the runtime card, verifies a fresh signed gateway
challenge, redirects to gateway-owned consent, exchanges the code for a
scoped grant, creates an Agent Connect session, and streams the real
Codex task.

## Security boundary

Only authorize applications you trust. The consent screen restricts which
application Origin and tool snapshot receive access but it cannot make malicious
prompts suddenly safe. This reference profile is not an arbitrary-app
sandbox. The deterministic public demo is the safer profile for anonymous
judge demo because it contains no Codex credential or general agent shell.
