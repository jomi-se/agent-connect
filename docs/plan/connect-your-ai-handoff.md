# Compact continuation handoff

Checkpoint: 2026-09-06, native seam `9ef0b39` on `work/openclaw-gateway`.
Goal remains a real Tailscale-flavored OpenClaw → SDK → Bookhand vertical slice.
It is **not complete**. No push or live service migration has occurred.

## Resume economically

Use one implementation agent. Avoid rebuilding working artifacts or repeating
component reconnaissance. A bounded reviewer is useful after the next actual
integration result, not several interconnected coding lanes in parallel.
Read the active ledger in `connect-your-ai-openclaw.md` and the specific files
needed below; the full conversation is not required. Subagents are checkpointed
and idle. Continue to use quiet commands and preserve unrelated work.

## Implemented and checked

- Durable grants: `4c271ed`; AI SDK execution helpers: `c8d680b`.
- Browser OAuth client/exports: `cf3b3d1`; actual client/handler lifecycle test:
  `dedb8ef`; compiled consent plugin: `995423f`.
- Native OpenClaw patch, reproduction instructions and smoke: `9ef0b39`.
- Default repository verify passed. Native smoke separately passed approved
  client-tool execution, token-refresh continuation, absence of native tools,
  and isolation/rejection checks. Actual compiled plugin load, discovery, PAR
  and forged-owner denial passed.
- Generic OpenClaw SDK declaration checker has an unresolved `__exportAll`
  error. Runtime/required compiled exports work; do not claim all build gates pass.

## Exact next work

1. Prove the **combined positive** isolated flow using the actual compiled plugin:
   PAR → managed-ingress/WhoIs test fixture consent → issued token → native
   Responses. This has not run. Separate OAuth and native-fixture passes do not
   prove registration/request fingerprint parity for the actual bundle.
2. Obtain owner approval before changing live Tailscale routes or subscription
   runtime setup. Follow the two-stage owner bootstrap in
   `openclaw-native-application-principal-seam.md`. Never approve real consent
   for the owner, expose credentials, or infer ownership from forwarded headers.
3. Coordinate with the existing Bookhand Codex in tmux `cdx2:1.1`; it owns the
   dirty `work/openclaw-tutor-demo` checkout. It received SDK/patch provenance
   and reports its integration, focused tests, and disconnected mobile browser
   checks pass. Verify current state rather than overwriting its work.
4. Run real owner consent and subscription-backed Bookhand source lookup →
   useful saved Study artifact → contextual follow-up → reload/source-link
   verification. Preserve partial effects; no automatic replay after ambiguity.

## Contract reminders

Bookhand uses memory-only per-tab credentials, with pending PKCE/intent in
sessionStorage. One shared connection generation/getter spans features; book
conversations have independent lifetimes. Every request carries the full fixed
approved tool declarations. Refresh uses caller-owned atomic compare-and-swap;
cross-tab CAS alone does not serialize refresh requests. The required separate
AI SDK dependency patch and installation steps are in `connect-your-ai-sdk.md`.

For native app-only policy, use explicit `tools.deny: ["*"]`: an empty native
allowlist is permissive. Managed Tailscale owner authentication uses the actual
listener-attributed request; ordinary HTTPS owner login remains outside v0.
