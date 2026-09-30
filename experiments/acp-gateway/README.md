# ACP gateway spike

Experimental code for the [ACP gateway spike](../../docs/plan/acp-gateway-spike.md).
Results: [`docs/experiments/acp-gateway.md`](../../docs/experiments/acp-gateway.md).
Not part of the npm workspaces or any release.

## Layout

- `src/policy.rs`: Agent Connect policy proxy (default-deny ACP and
  MCP-over-ACP filter) plus a test-only spy proxy.
- `src/lib.rs`: harness launch recipes and the application tool fixture.
- `src/bin/tool_client.rs`: plays the application, offering tools over
  MCP-over-ACP through the policy proxy, the official polyfill and an
  unmodified adapter.
- `mock-model/server.mjs`: scripted Responses and Messages model server that
  logs every request.
- `adapters/`: pinned `codex-acp` and `claude-agent-acp`.
- `.run/`: gitignored isolated harness configuration, workspace and logs.

## Run

```sh
cd experiments/acp-gateway
(cd adapters && npm ci)
mkdir -p .run/codex-home .run/claude-config .run/workspace
# .run/codex-home/config.toml selects the mock provider; see the results doc.
MOCK_LOG=.run/mock-requests.jsonl node mock-model/server.mjs &
cargo run --bin tool_client -- --harness codex
cargo run --bin tool_client -- --harness claude
# Enforce a consented snapshot, or behave like a hostile application:
cargo run --bin tool_client -- --harness claude --snapshot .run/snapshot.json --attack
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
