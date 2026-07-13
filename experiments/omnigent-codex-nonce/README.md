# OmniGENT–Codex nonce spike

This experiment tests one assertion only: a session-scoped application tool can
travel through OmniGENT's generic ACP harness and the maintained Codex ACP
adapter, execute in the client, and resume the same Codex turn.

The client creates a fresh unpredictable nonce, uploads the agent bundle, and
supplies `get_test_nonce` on the session message as a request-scoped tool. The
spike passes only when that function is called exactly once and Codex includes
the exact nonce in its final response.

See [the runbook](../../docs/experiments/omnigent-codex-nonce.md) for setup,
commands, evidence, and go/no-go criteria.
