# VAL-TEST-002: Real Omnigent and deterministic ACP complete the tool loop

Surface: api, protocol, data.
Needs: the repository's supported Node toolchain and Omnigent CLI version
`0.5.1`, recorded in `config/omnigent-test-compat.json`; no Codex credential, model API key,
Tailscale daemon, browser, or external runner is required.
Behavior: an opt-in integration test starts a disposable real Omnigent server
and host, then uses the real Agent Connect HTTP session/events/stream surface
with `OmnigentRuntime`. The gateway provisions its agent bundle. A deterministic
standards-valid ACP agent receives initialize, session/new, and session/prompt,
starts the advertised stdio MCP server, lists the request-scoped
`get_test_nonce` application tool, calls it without a nonce, and waits for the
resulting Omnigent `action_required`. Only then does the application generate a
fresh unpredictable nonce and return it under the emitted call ID. The agent
must incorporate that application-generated value into its final streamed
text. All service home, config, data, logs,
cache, runner, transcript, and workspace paths are isolated under one temporary
root and no Codex credential is present.
Evidence: the explicit integration command rejects a version other than the
checked-in `0.5.1` compatibility value and reports the accepted version;
captures initialize, session/new, session/prompt, MCP tools/list and
tools/call in the deterministic agent transcript; proves the MCP call contained
no nonce, generates the nonce only after observing `action_required`, submits
one result using the emitted call ID, and captures the returned nonce at the
agent only after the MCP response; observes that nonce in final text plus normal
completion through the gateway SSE route; verifies `HOME`,
`OMNIGENT_CONFIG_HOME`, `OMNIGENT_DATA_DIR`, XDG/cache, logs, runner,
transcript, workspace, database, and artifact paths are under the temporary
root; verifies canaries in the operator's normal Omnigent and Codex homes remain
unchanged; and
proves child PIDs stop and selected ports close. A deliberate post-start failure
cleanup test proves the same process cleanup path. The normal repository test
command skips this service test unless explicitly requested.
Fail: the test bypasses the Agent Connect HTTP surface after provisioning; the
agent can pass without a tools/list and tools/call round trip; it reads a real
Codex login or makes a model request; any service writes into the operator's
normal Omnigent/Codex home; the tool result is not correlated to the emitted
call ID; or cleanup leaves a server, host, runner, port, or temporary service
root behind.
Scope: this validates the pinned narrow Omnigent/ACP/MCP composition used by
Agent Connect. It does not claim compatibility with arbitrary ACP agents, full
MCP, Tailscale, or a real Codex model. A real Omnigent/Codex/browser smoke test
remains the separate layer-three milestone proof.
