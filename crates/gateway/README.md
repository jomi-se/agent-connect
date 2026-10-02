# Agent Connect ACP gateway

Unreleased implementation of proposed [ADR 0016](../../docs/decisions/0016-acp-application-boundary.md).
ACP, MCP-over-ACP and `agent-connect.resume.v1` surfaces are **unstable**.
The OpenClaw plugin remains the current release and is retained.

Build with `cargo build --locked --bin agent-connect-gateway`; run unit tests
with `cargo test --locked`. `npm run verify` additionally runs the real pinned
Codex and Claude ACP adapters against deterministic inference in Chromium.
It creates temporary harness homes and never uses personal logins.

The operator supplies an exact browser origin, bearer grant and consented tool
snapshot with `--allow-origin`, `--token`, and `--tools`. Grant issuance and
revocation remain release prerequisites. The gateway restricts session ownership,
permits one active prompt per chain, owns session setup and permission answers,
and journals application actions before delivery. Journal files are evidence of
uncertain effects after a crash; they are never automatically replayed. Applications
must deduplicate side effects with the stable `agent-connect/actionId`.

The experimental browser fixture and deterministic model remain under
`experiments/acp-gateway`. Host adapter launches are test-only and provide no
native-action isolation; container sessions provide that boundary.
