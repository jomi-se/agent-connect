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
deterministic model fixture. Raw evidence is private under
`.agent-connect/openclaw-demo/attempt-1788612953121`.

Transcript-store provenance independently records API `openai-chatgpt-responses`,
provider `openai`, model `gpt-5.6-sol`; the secret-free `model-provenance.json`
artifact is in that evidence directory.

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
Evidence and running PID are referenced by the private `summary.json`.

## Private Bookhand demo

- Upstream: loopback `127.0.0.1:45529`, agent `main`.
- Agent Connect: tmux `agc-openclaw`, loopback `127.0.0.1:8789`; health passed.
- Intended private HTTPS gateway: `https://artifex-box.tail246db1.ts.net:8446`.
- Bookhand origin: `https://artifex-box.tail246db1.ts.net:8445`.
- Public card: `.agent-connect/openclaw-demo/agent-connect/public-runtime-card.json`.
- Private gateway environment and independent auth/response state are adjacent.
  The gateway identity and passphrase verifier were retained, but grants/devices
  were cleared and a new capability secret generated for this isolated profile.
  No mutable authority store is shared with the original gateway.

The new Serve route requires the owner to run:

```sh
sudo tailscale serve --bg --https=8446 http://127.0.0.1:8789
```

This setup does not alter the existing private gateway or its routes. Bookhand's
agent has the public card path and must wait for normal owner consent. Actual
Bookhand browser-to-model acceptance remains open; the direct upstream smoke
does not substitute for it.

## Auth lifetime boundary

The base Codex account remains the refresh owner. Continuous OpenClaw operation
across access-token expiry has not been proven. Do not copy a refresh token or
start another login automatically if bootstrap becomes unavailable. See
[the pinned auth investigation](2026-09-05-openclaw-subscription-auth.md).
Official [Codex authentication documentation](https://learn.chatgpt.com/docs/auth)
distinguishes ChatGPT subscription sign-in from separately billed API keys and
describes Codex's own token refresh; it does not by itself prove OpenClaw behavior.
