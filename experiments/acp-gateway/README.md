# ACP gateway spike

Experimental code for the [ACP gateway spike](../../docs/plan/acp-gateway-spike.md).
Results: [`docs/experiments/acp-gateway.md`](../../docs/experiments/acp-gateway.md).
Not part of the npm workspaces or any release.

## Layout

- `src/policy.rs`: the Agent Connect policy proxy (a default-deny ACP and
  MCP-over-ACP filter, a per-grant session registry and permission profiles)
  plus a test-only spy proxy.
- `src/lib.rs`: harness launch recipes (mock, boxed and live) and the
  application tool fixture.
- `src/bin/tool_client.rs`: plays the application without a browser: offers
  tools over MCP-over-ACP, with `--attack`, `--boxed` and `--live` modes.
- `src/bin/gateway.rs`: browser-facing ACP-over-WebSocket gateway, one chain
  per connection, with optional `--boxed`.
- `src/bin/session_runner.rs`: runs inside a session container: polyfill and
  adapter on stdio.
- `web/`: a reader page that serves its own tools in the page, plus a
  Playwright driver (`drive.mjs`).
- `sandbox/`: session image, egress proxy, setup (`up.sh`) and network probes
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
cargo run --bin gateway -- --harness claude --listen 127.0.0.1:18943 &
(cd web && PAGE_ORIGIN="http://127.0.0.1:18941/?gateway=ws://127.0.0.1:18943/acp" node drive.mjs tools)

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
