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

Production runs use `agent-connect-gateway serve --boxed --harness codex`, with
`--harness-home`, `--egress-container`, `--tools`, `--token` and `--allow-origin`.
The shared home must be dedicated, private (0700) and owned by the invoking user;
containers run as that UID/GID. The home includes credentials and transcripts,
so a consented application could obtain the dedicated login and read other
applications' transcripts. See the [credential boundary](../../docs/plan/acp-gateway-credentials.md).

`agent-connect-gateway login --harness codex --harness-home /path/to/dedicated-home`
runs the one-time device login in the session image. The owner runs it; tests
never authenticate. `--harness claude` opens `/login`; Claude Code is unconfirmed
against Anthropic terms. `setup-token` is a compared variant only. API-key
variables are never supplied to boxes. Host adapter launches require an explicit
isolated `--mock-root`; this is only a deterministic test mode.
