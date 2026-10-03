# ACP gateway spike

Experimental code for the [ACP gateway spike](../../docs/archive/plans/acp-gateway-spike.md).
Results: [`docs/experiments/acp-gateway.md`](../../docs/experiments/acp-gateway.md).
Not released. The gateway implementation now lives in `crates/gateway`;
this directory retains deterministic fixtures and compatibility entry points.
`npm run verify` runs the browser scenarios against the product binary.

## Layout

- `../../crates/gateway/src/policy.rs`: the Agent Connect policy proxy (a default-deny ACP and
  MCP-over-ACP filter, a per-grant session registry and permission profiles)
  plus a test-only spy proxy.
- `src/lib.rs`: harness launch recipes (mock, boxed and live) and the
  application tool fixture.
- `src/bin/tool_client.rs`: plays the application without a browser: offers
  tools over MCP-over-ACP, with `--attack`, `--boxed` and `--live` modes.
- `src/bin/gateway.rs`: browser-facing ACP-over-WebSocket gateway, with
  optional `--boxed` and `--durable-home`.
- `../../crates/gateway/src/resume.rs`: session hosts that outlive their socket, and the opt-in
  `agent-connect.resume.v1` transport (sequence-acknowledged frames, reattach,
  grace period, retention bound).
- `src/bin/session_runner.rs`: runs inside a session container: polyfill and
  adapter on stdio.
- `web/`: a reader page that serves its own tools in the page
  (`resumable-stream.js` is its mobile transport), Playwright drivers
  (`drive.mjs`, and `drive-mobile.mjs` for mobile lifecycle), and a
  fault-injecting relay (`relay.mjs`).
- `sandbox/`: archived image alias, setup (`up.sh`) and network probes
  (`probe.sh`).
- `mock-model/server.mjs`: scripted Responses and Messages model server that
  logs every request.
- `adapters/`: pinned `codex-acp` and `claude-agent-acp`.
- `.run/`: gitignored isolated harness configuration, workspaces and logs.

## Run

```sh
cd experiments/acp-gateway
(cd adapters && npm ci) && (cd web && npm ci && npm run build)
mkdir -p .run/codex-home .run/claude-config .run/workspace
# .run/codex-home/config.toml selects the mock provider (below).
MOCK_LOG=.run/mock-requests.jsonl node mock-model/server.mjs &

# Without a browser
cargo run --bin tool_client -- --harness codex
cargo run --bin tool_client -- --harness claude --snapshot .run/snapshot.json --attack

# Browser
python3 -m http.server 18941 --bind 127.0.0.1 -d web &
cargo run --bin gateway -- serve --harness claude --listen 127.0.0.1:18943 \
  --mock-root "$PWD" --state-dir .run/state --tools web/tools.json \
  --allow-origin http://127.0.0.1:18941 --token spike-dev-token &
(cd web && PAGE_ORIGIN="http://127.0.0.1:18941/?gateway=ws://127.0.0.1:18943/acp" node drive.mjs tools)

# Mobile lifecycle: the page goes through the relay; add ?resume=0 for plain ACP
(cd web && node relay.mjs &)
(cd web && PAGE_ORIGIN="http://127.0.0.1:18941/?gateway=ws://127.0.0.1:18946/acp" node drive-mobile.mjs slow-cut)
# expire and overflow need --resume-grace-secs 5 and --resume-max-bytes 3000

# Container per session
./sandbox/up.sh && ./sandbox/probe.sh
cargo run --bin tool_client -- --harness codex --boxed --codex-mode agent-full-access
```

The mock Codex configuration is:

```toml
model = "mock-model"
model_provider = "mock"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.mock]
name = "Spike mock"
base_url = "http://127.0.0.1:18931/v1"
wire_api = "responses"
requires_openai_auth = false
```

`--live` uses the owner's real harness login in place, on the host, with a
clean process environment. It spends subscription allowance, and it is not a
security boundary.

The canonical session image and egress proxy now live in `deploy/acp-gateway`.
The local multi-architecture build is `deploy/acp-gateway/session/build-local.sh`
from the repository root. It creates no registry release.

The reader now imports the product web SDK. Build that workspace first and
bundle the page from this checkout so the workspace dependency resolves. The
root scenario runner does this automatically, keeping adapter installs and
browser outputs in private temporary directories. `?chat=1` mounts the
useChat example. `web/resumable-stream.js` is retained only as archival spike
source; the active transport is `packages/web-sdk/src/resumable-acp-stream.ts`.
