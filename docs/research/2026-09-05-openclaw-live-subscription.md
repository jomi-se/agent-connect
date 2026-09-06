# Built-in OpenClaw subscription composition

2026-09-05. José explicitly selected OpenClaw's own loop: the product requirement
is using the user's AI subscription, not retaining the Codex executable.

## Executed evidence

Pinned OpenClaw 2026.9.1 used `openai/gpt-5.6-sol`, runtime `openclaw`, and
runtime-only OAuth bootstrap from the existing Codex account. No API-key
environment or model fallback was supplied. The source credential was not
copied, changed, or refreshed by this setup.

The corrected live test completed three Responses segments: an application tool
request, consumption of its newly generated library shelf label, and a follow-up
recalling that same label. This is real subscription-backed inference, not the
deterministic model fixture. Raw evidence is retained privately; machine-specific
artifact locations and deployment notes are not part of the public repository.

Transcript-store provenance independently records API `openai-chatgpt-responses`,
provider `openai`, model `gpt-5.6-sol`; the secret-free `model-provenance.json`
artifact was retained with the private evidence.

The first attempt is retained separately: subscription inference and tool return
worked, but describing the fixture value as a secret triggered a refusal on the
follow-up. It also exposed a background embeddings attempt rejected with
`billing_not_active`. This was not a subscription-model fallback, but still an
unwanted auxiliary API dependency.

The corrected profile disables memory plugins explicitly (`slots.memory: none`,
`memory-core.enabled: false`). Its fresh log has no embeddings/billing entries.
Do not infer that subscription-backed inference alone disables every auxiliary
service in a default OpenClaw installation.

The successful model run was initially followed by an audit failure because the
test inspected an exclusively locked, unrelated SQLite database. Narrowing the
audit to actual auth stores fixed that setup error. The service was restarted
without further inference. Before/after startup audits confirmed unchanged source
auth, no persisted source credential bytes and no managed OpenAI OAuth profile.
This is dated test evidence, not a statement about a currently running service.

## Browser acceptance boundary

A direct upstream subscription smoke and a successful HTTPS health check do not
prove browser-to-model composition. Acceptance requires the application to
complete normal owner consent and then a real tool/result/follow-up flow under
its actual browser policy. That acceptance was not established by this test.

For reproducible setup instructions, see the
[gateway deployment guide](../../deploy/openclaw-gateway/README.md). Keep actual
hostnames, service sessions, evidence paths and operator coordination in
gitignored local notes rather than this research report.

## Auth lifetime boundary

The base Codex account remains the refresh owner. Continuous OpenClaw operation
across access-token expiry has not been proven. Do not copy a refresh token or
start another login automatically if bootstrap becomes unavailable. See
[the pinned auth investigation](2026-09-05-openclaw-subscription-auth.md).
Official [Codex authentication documentation](https://learn.chatgpt.com/docs/auth)
distinguishes ChatGPT subscription sign-in from separately billed API keys and
describes Codex's own token refresh; it does not by itself prove OpenClaw behavior.
