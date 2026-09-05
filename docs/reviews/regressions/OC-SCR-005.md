# OC-SCR-005: current operator documentation contradicts replacement

Target: VAL-OC-004. Read-only reproduction:

Status: resolved by follow-up documentation inspection on 2026-09-05.

`rg -n 'Omnigent|omnigent' README.md docs/architecture/testing-strategy.md AGENTS.md`

Original finding: README gave the old supervisor quickstart and deleted Omnigent integration
script as current. Testing strategy describes removed BackendEvent fixtures and
the old dependency as the default gate. AGENTS command guidance likewise claims
verify requires Omnigent, while package.json now runs real OpenClaw.

Update current source-of-truth instructions; retain historical deployment material
only with an explicit historical/live-main label. No need to preserve old engine
code to satisfy the old text.

Verified resolution: README and AGENTS now identify the real OpenClaw default
gate; testing strategy describes deterministic inference behind the shipped
dependency; gateway package README documents actual OPENCLAW configuration,
private routing, local cancellation and migration limits. Root quickstart now
exports AGENT_CONNECT_OPENCLAW_ENV_FILE before check/serve. No tests rerun for
this documentation-only follow-up. Actual subscription/browser acceptance
remains separate and unproven.
