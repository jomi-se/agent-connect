# Plugin SDK and Bookhand migration

2026-09-08. Active on `work/openclaw-plugin-host`, following `1b8b67a`.
Owner authorized implementation, not live cutover or push.

## Boundary

The SDK owns supported provider URL layouts, discovery, connection-record shape
and tool-hash validation, scoped history request paths, wire parsing, response
bounds and provider error classification. Bookhand owns storage selection,
credential locking/rotation markers, absolute consent lifetime, app/tab/book
identity and generation guards, cancellation and UI. Do not build a generic
provider framework or change Responses generation behavior in this slice.

## SDK work (Sol)

- Add exported `parseOpenClawConnection(serialized, options)` returning a Promise
  of a validated immutable connection. Options require the expected `clientId`,
  with optional injected `now` milliseconds. Validate unknown input/record bounds,
  exact supported fields/layout, tool declarations with CSP-safe validation and
  recomputed approved tool hash. Allow expired access tokens if refresh validity
  remains; reject expired refresh authority. No network/storage side effects and
  no silent consent renewal. This is structural validation, not proof the server
  has not revoked the grant. Bookhand retains its stricter absolute expiry clamp.
- Add `serializeOpenClawConnection(connection)` and
  `getOpenClawConnectionProviderUrl(connection)`. Add
  `normalizeOpenClawProviderUrl(value)` for address preferences. Preserve both
  standalone origin and plugin `/agent-connect` layouts without leaking their
  path rules into the consuming app. Pending transactions already expose their
  verified `issuer`; use that for callback rediscovery, not `providerOrigin`.
- Add `createOpenClawConversationClient({connection,getAccessToken,fetch?})` with
  `list({signal?})` and `history(conversationId,{signal?})`. Return typed readonly
  descriptors/execution-history, using current gateway wire semantics (timestamps
  in epoch milliseconds, explicit input/assistant entries, bounded/truncated projection).
  Internal endpoint selection comes from validated connection, never caller URL.
  Validate opaque IDs and parse bounded JSON in the SDK. Use credentials:omit,
  redirect:error, cache:no-store. Preserve abort/error cause; no automatic replay.
  Token getter is injected so Bookhand's shared refresh/CAS ownership remains.
  Getter may reject stale generation before requests; Bookhand also guards after
  await before adopting a result. Do not capture an access token permanently.
- Export `OpenClawConversationUnavailableError` for native expired/missing/changed
  conversation outcomes; keep transport/invalid-body/auth failures distinct, not
  silently classed as lost conversation. Do not expose arbitrary server messages.
- Move the relevant parsing logic from Bookhand into the SDK semantically, not
  by importing Bookhand code. See `/home/dev/bookhand/src/ai/conversation-history.ts`
  and `connection-persistence.ts`; inspect current limits and test edge cases.
- Reuse existing bounded JSON, schema and hash helpers where appropriate. Keep
  browser code CSP-safe and free of Node imports. Update SDK docs and package
  smoke exports; test both layouts, malformed/cross-origin endpoints, tool-hash
  mismatch, refreshable vs expired record, typed history errors, abort and bounds.
- Deliver exact exported signatures, local SDK tarball/hash/provenance to root.
  No Bookhand edits or independent live deployment.

## Bookhand work (CDX2, after contract handoff)

- Install exact tarball with provenance, retain existing AI SDK continuation patch.
- Replace hardcoded history URLs/fetch/parser with SDK client and types; retain
  book/connection generation guards, access lifetime and no-replay behavior.
- Delegate inner saved connection validation/hash/schema checks to SDK parser;
  retain app envelope, app-origin and absolute grant-expiry checks, lock/CAS and
  rotating-marker behavior. Do not persist additional secrets or widen retention.
- Preserve verified issuer during callback rediscovery and saved provider address
  recovery; no rebuilding plugin path in application code. Update reconnect
  preferences and schema tests without relaxing URL/issuer binding.
- Focused connection/restore/history tests for both layouts, real installed SDK;
  strict-CSP phone-width production smoke without model calls or owner consent.
  Do not change Tutor, tool catalog, Study content, prompts or generation protocol.

## Review and finish

Root reviews auth changes and new public helpers, then CDX2's migration evidence.
Real installed plugin OAuth/history composition should exercise new SDK helpers
where practical; no broad repeated test matrix. Report deterministic proof vs
unperformed owner-device live test separately. Commit bounded work locally;
leave branch and deployments unchanged until owner-approved rollout.

## Ledger

- [x] Auth/checker update `1b8b67a` delivered; real installed token/password/none
      tests reported passing by Sol. Root inspecting shared validation and auth use.
- [x] SDK helpers implemented and root source review completed; focused and full
      web SDK tests, typecheck, build, formatting, packed-consumer smoke and real
      installed-stock-plugin history composition pass.
- [x] Candidate SDK artifact delivered for CDX2 install at
      `dist/open-agent-connect-web-0.0.3.tgz`, SHA-256
      `ccd489d55189df32654c3e3bf2dc667ee65545d4d0d453f52eff7cbbfb128480`.
- [ ] Bookhand removes provider-route/record duplication.
- [ ] Focused installed-SDK and production CSP evidence reviewed.
- [ ] Final handoff; no live-cutover claim.
