# OpenClaw 2026.9.1: subscription auth for the built-in loop

Update: José selected this route and the bounded live tool/follow-up test passed.
See [executed evidence](2026-09-05-openclaw-live-subscription.md). The source-only
investigation below is retained separately from those later measurements.

Source-only investigation, 2026-09-05. No real credentials inspected, login or refresh performed, or service started/restarted. Source pin: official `v2026.9.1`, locally `/tmp/openclaw-contract.suVXov/openclaw-2026.9.1`.

## Conclusion

The built-in OpenClaw loop supports ChatGPT subscription OAuth. It does not require using the native Codex harness, whose HTTP client-tool gap was separately demonstrated. The explicit supported route is canonical `openai/gpt-5.6-sol`, selected `openai` OAuth, and model-scoped `agentRuntime.id: "openclaw"`. Provider code resolves this to the internal `openai-chatgpt-responses` transport.

Single-account reuse has a narrow, useful path: with no OpenClaw-owned OAuth material for OpenAI, existing Codex CLI OAuth can supply a **runtime-only** `openai:default` bootstrap. This is not a persisted copy or a general bidirectional credential-sync scheme. It is suitable to test as a bounded demo prerequisite, but has not been exercised with real account credentials here.

## Minimal proposed demo configuration

```json
{
  "auth": {
    "profiles": { "openai:default": { "provider": "openai", "mode": "oauth" } },
    "order": { "openai": ["openai:default"] }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "openai/gpt-5.6-sol", "fallbacks": [] },
      "models": {
        "openai/gpt-5.6-sol": { "agentRuntime": { "id": "openclaw" } }
      }
    }
  }
}
```

Keep demo OpenClaw state/auth storage isolated and empty of persisted OpenAI OAuth; do not copy auth.json, import/migrate tokens, or run login merely to make this bootstrap work. The source reader uses `CODEX_HOME` when already configured, otherwise the normal Codex CLI home. A demo launcher needs an explicitly reviewed read-only reference to that existing account source; it must not substitute an isolated empty Codex home and then infer the user is unauthenticated. Do not broaden gateway authority or change the separate client-tool policy as part of auth setup. Clear unrelated API-key fallback variables in the demo child environment if subscription-only billing is required.

This configuration is source-backed, not a completed real-account smoke test. The next authorized test should verify profile source/provenance and one bounded model turn without printing token material, then verify no OAuth credential was persisted into demo state. If the base credential is expired or bootstrap unavailable, stop for user direction; do not silently initiate a new login or token refresh.

## Refresh ownership and caveats

- `external-cli-sync.ts` registers OpenAI as `bootstrapOnly: true`. It refuses bootstrap once any managed OpenAI OAuth inline material exists and returns bootstrap profiles with `persistence: "runtime-only"`.
- `oauth-shared.ts` marks these profiles as runtime external; unchanged runtime-only credentials are not supposed to be persisted.
- `oauth-manager.ts` uses an unexpired effective access token directly. Its refresh path reloads the persisted-only auth store; if the runtime-only profile has no persisted owner, it returns null before calling the refresh adapter. This supports the inference that an entirely empty-store bootstrap does not spend a copied Codex refresh token. It is not an executable refresh-race proof.
- Codex CLI remains the refresh owner in that narrow mode. OpenClaw can re-read CLI state, but automatic fresh-token discovery at every relevant long-lived runtime boundary is not established here. Do not promise uninterrupted unattended service beyond access-token expiry.
- Once OpenClaw owns a persisted OAuth profile, its token becomes canonical. Rejected local refresh does not fall back to newer/same-account CLI material. Copying a CLI token into OpenClaw defeats the safe empty-store condition and introduces separate refresh ownership.
- The public docs warn that independent OAuth logins/refreshes can invalidate a previous refresh token. The supported independent-login CLI commands below are therefore not evidence that parallel Codex/OpenClaw logins have zero disruption risk for this user's single account.

## Supported independent-login path (not executed)

The documented commands are `openclaw models auth login --provider openai` or, for a headless setup, `openclaw models auth login --provider openai --device-code`. `openclaw onboard --auth-choice openai` also exists. Onboarding explicitly no longer imports OAuth material from the Codex home; these create OpenClaw-owned credentials. After login, retain the explicit built-in runtime selection above, because the ordinary official OpenAI route may otherwise automatically select native Codex. Use the actual returned profile ID in auth order if not `openai:default`.

Recommendation: preserve the existing account and try only the reviewed runtime-only bootstrap path when authorized. If that is insufficient, surface the ownership choice to the user rather than copying refresh tokens or starting another login automatically.

## Exact pinned evidence

- [Provider docs](https://github.com/openclaw/openclaw/blob/v2026.9.1/docs/providers/openai.md), lines 305-357: login commands and explicit built-in subscription routing; 417-419: no onboarding import; 633-665 describes a separate native app-server auth bridge, not the built-in loop.
- [OAuth ownership docs](https://github.com/openclaw/openclaw/blob/v2026.9.1/docs/concepts/oauth.md), lines 40-60, 176-191: token ownership, bootstrap, refresh caveats.
- [External CLI sync](https://github.com/openclaw/openclaw/blob/v2026.9.1/src/agents/auth-profiles/external-cli-sync.ts), lines 73-82, 164-189, 284-289, 440-454: Codex bootstrap, managed-profile exclusion, runtime-only provenance.
- [Discovery scope](https://github.com/openclaw/openclaw/blob/v2026.9.1/src/agents/auth-profiles/external-cli-scope.ts), lines 92-126: configured model/auth profiles/order put OpenAI in discovery scope.
- [CLI source reader](https://github.com/openclaw/openclaw/blob/v2026.9.1/src/agents/cli-credentials.ts), lines 81 onward and 436-494: configured Codex home, credential file/keychain read, cached read.
- [OAuth manager](https://github.com/openclaw/openclaw/blob/v2026.9.1/src/agents/auth-profiles/oauth-manager.ts), lines 243-246, 508-535, 729-770: persisted-only refresh owner and direct usable-token path.
- [Runtime provenance](https://github.com/openclaw/openclaw/blob/v2026.9.1/src/agents/auth-profiles/oauth-shared.ts), lines 156-211: runtime-only overlay and persistence policy.
- [Provider transport](https://github.com/openclaw/openclaw/blob/v2026.9.1/extensions/openai/openai-provider.ts), lines 505-525, 737-752: subscription transport/API and OAuth routing.
- [Bootstrap tests](https://github.com/openclaw/openclaw/blob/v2026.9.1/src/agents/auth-profiles/external-oauth.test.ts), lines 307-334 and 502-555: scoped CLI bootstrap published into runtime store, tokenless default-profile reuse. Tests inspected, not run.
