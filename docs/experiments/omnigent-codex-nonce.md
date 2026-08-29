# Omnigent–Codex composition spike

## Decision under test

Adopt Omnigent as a conductor candidate only if its generic ACP harness can
expose a session-owned client tool to Codex, return the client result through
`action_required`, and let the same Codex turn finish.

This spike deliberately excludes the browser SDK, upstream ACP WebSocket,
MCP-over-ACP, persistence, reconnect, and the spreadsheet demo.

## Pinned environment

- Omnigent: `0.5.1`, installed from the upstream bootstrap script.
- Codex ACP: `@agentclientprotocol/codex-acp@1.1.2`, pinned in the root npm lockfile.
- Codex CLI used by the adapter: the version bundled by the pinned adapter.
- Omnigent upstream inspected at `7f1f2f1ae7c8a889c245fcc5abd413d26089036f`.
- Codex ACP upstream inspected at `f3f1b3c488096786e22180852091b0f005c28850`.

Upstream source currently declares Codex ACP `1.1.3`, but that version was not
published to npm on 2026-07-13. The first reproducible run therefore uses the
newest published version, `1.1.2`.

Omnigent's sessions wire accepts request-scoped tools on a message event, but
`SessionsChat` 0.5.1 does not expose that top-level field and validates its
callables only against spec-declared `runtime: client` tools. The spike contains
a narrow compatibility adapter: it supplies the declaration to that SDK
preflight and injects the real OpenAI-format schema at the namespace event
boundary. The agent bundle itself declares no nonce tool, so Omnigent correctly
classifies the schema as application-supplied rather than local. This does not
mock server dispatch, `action_required`, result submission, the ACP/MCP relay,
or Codex; failure in any of those live layers still fails the spike.

## Prerequisites

The machine needs Python 3.12+, `uv`, Node.js 22+, npm, Git, and a working Codex
login. Confirm the login without printing credentials:

```sh
codex login status
```

Install Omnigent if it is not already present:

```sh
curl -fsSL https://omnigent.ai/install.sh | sh
```

Install the monorepo dependencies, including the pinned adapter:

```sh
npm install
```

## Isolated Omnigent state

For the spike, point Omnigent configuration, database, logs, and artifacts at
the gitignored `.omnigent-spike/` directory. This avoids altering normal
Omnigent configuration. The local config registers the repository-pinned
`node_modules/.bin/codex-acp` command as `acp:codex-acp`.

Every Omnigent command below must carry both variables:

```sh
export OMNIGENT_CONFIG_HOME="$PWD/.omnigent-spike"
export OMNIGENT_DATA_DIR="$PWD/.omnigent-spike"
```

The generic ACP subprocess does not use Omnigent's native Codex executor, so it
does not automatically receive that executor's private writable `CODEX_HOME`.
Do not point it directly at the user's real `~/.codex`: Codex app-server writes
SQLite state there. Instead, create a private runtime home, link only the login
file, and copy configuration using the same isolation pattern as Omnigent's
native Codex executor:

```sh
mkdir -p .omnigent-spike/codex-home
ln -s "$HOME/.codex/auth.json" .omnigent-spike/codex-home/auth.json
cp "$HOME/.codex/config.toml" .omnigent-spike/codex-home/config.toml
export CODEX_HOME="$PWD/.omnigent-spike/codex-home"
export OMNIGENT_RUNNER_ENV_PASSTHROUGH=CODEX_HOME
```

The explicit passthrough is required because `omnigent host` allowlists the
environment inherited by a runner. The auth symlink remains read-only from the
runtime's perspective while app-server state stays under the gitignored spike
directory. Do not put OpenAI credentials in experiment YAML or commit the
private runtime home.

## Start and inspect Omnigent

```sh
omnigent server start
omnigent server status
```

Use the URL printed by `server start` or `server status`; Omnigent may select a
free random port rather than `6767`. In a second terminal, attach the local host
daemon to that exact URL and leave it running:

```sh
omnigent host http://127.0.0.1:PORT
```

Confirm `GET /v1/hosts` reports exactly one online host before running the
spike. Keep this first proof local; do not expose the server or Codex app-server
transport publicly.

## Run the proof

Use the Python client version matching Omnigent:

```sh
mkdir -p .omnigent-spike/evidence
UV_CACHE_DIR="$PWD/.omnigent-spike/uv-cache" \
  uv run --python 3.12 --with omnigent-client==0.5.1 \
  python experiments/omnigent-codex-nonce/run.py \
  --base-url http://127.0.0.1:PORT \
  | tee .omnigent-spike/evidence/nonce.jsonl
```

Expected event sequence:

1. `spike.started`
2. `session.created`
3. `runner.launching`, then `runner.online`
4. `client_tool.called` with a server-issued call ID
5. `turn.completed` with `tool_call_count: 1`
6. `spike.passed` with the same call ID and nonce

The nonce is generated only after the process starts. Its presence in the final
Codex response proves that the value crossed the live tool path rather than
being guessed from the prompt or fixture.

## Pass and fail criteria

Pass only if:

- Codex discovers and calls `get_test_nonce`;
- Omnigent exposes it as an `action_required` client call;
- the Python callable runs exactly once;
- the result is correlated to the original call ID;
- the same turn completes; and
- Codex's final text contains the exact nonce.

Fail or time-box the experiment if authentication cannot be completed
headlessly, the tool never reaches Codex, the result cannot resume the same
turn, or fixing the path requires duplicating Omnigent's runner/session
lifecycle. Capture the server and adapter logs before changing architecture.

## Observed result — 2026-07-13

**Pass.** With Omnigent 0.5.1 and the published Codex ACP 1.1.2, a fresh local
run produced this sanitized sequence:

```text
session.created
runner.launching
runner.online
client_tool.called name=get_test_nonce arguments={} call_id=<server-issued>
turn.completed tool_call_count=1 text=<contains exact fresh nonce>
spike.passed tool_call_id=<same server-issued id>
```

Before the request-scoped injection was added, the same live stack completed a
Codex turn but exposed no nonce tool. Source tracing showed the distinction:
the runner derives `client_side_tool_names` from per-event tools, while a tool
bundled into the agent belongs to the spec/local surface. Moving the schema to
the message event made the full path pass without forking Omnigent or changing
`codex-acp`.

This retires the central composition risk for the narrow case: one session,
one request-scoped tool surface, one Omnigent runner, one generic ACP agent, and
one same-turn result. It does not yet prove browser transport, reconnect,
durability, mutation authorization, or multi-session behavior.

## Browser result — 2026-07-13

The follow-up browser slice also passed. An ordinary Vite application imported
the built `@open-agent-connect/web` package, created a provider-neutral
`AgentSession`, and supplied `get_browser_nonce` through the Omnigent adapter.
A real Chromium run observed exactly one `tool.requested`, one
`tool.completed`, and a terminal `task.completed`; the final Codex text
contained the unpredictable nonce generated inside the page. The test asserted
the message tool schema, correlated `function_call_output`, browser console,
and visible result.

This proves the current bring-your-own-agent path over Omnigent to Codex. It
does not prove a second conductor implementation or a second underlying agent.
The public provider contract and conformance tests preserve that future seam;
Omnigent's own multi-harness support supplies the immediate agent-level
agnosticism.

### Decision

Keep Omnigent as the first provider behind a harness-neutral gateway interface.
Use its existing HTTP/SSE sessions surface for the hackathon slice. Treat the
small session-message tool injection as provider-adapter code, and defer an
upstream ACP/WebSocket facade until the browser-to-Codex product loop works.

## Diagnostics

Check the isolated server state and logs:

```sh
omnigent server status
find .omnigent-spike/logs -type f -maxdepth 3 -print
```

The adapter can also write app-server logs when its command is configured with
`APP_SERVER_LOGS`; add that only when deeper diagnostics are needed, keeping the
directory under `.omnigent-spike/`.

Stop the isolated server when finished:

```sh
omnigent server stop
```

## Follow-up control

If this path fails, run the same nonce assertion directly against Codex
app-server dynamic tools. Do not build upstream ACP or browser transport layers
until one provider path has a captured passing trace.
