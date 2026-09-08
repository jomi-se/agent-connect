# Bounded scoped conversation history

The stock scoped proxy exposes recent conversations for the **current grant**:

- `GET /v1/agent-connect/conversations` returns `{ conversations }`.
- `GET /v1/agent-connect/conversations/:conversationId/history` returns the
  descriptor and `{ projection: "execution-history", entries, truncated }`.
- A descriptor is `{ conversationId, expiresAt, canContinue,
previousResponseId? }`. The response ID is present only when no application
  calls remain outstanding. Send it as `previous_response_id` on the existing
  `POST /v1/responses` endpoint with the same approved tools to continue.

Both reads require the same browser Origin and bearer authorization as Responses.
They never accept a provider session key. Listing is newest-expiry first and
includes only terminal completed heads still in the in-memory registry (at most
8 per grant, 30-minute inactivity expiry). Active, consumed, failed and expired
heads are unavailable. Pending-call heads can be inspected but cannot be reopened
as a new learner turn. Reads do not extend expiry or consume a head.

History comes from stock OpenClaw `chat.history`, not a copied transcript store.
Grant/policy authority is checked before reading and again after the upstream
wait; changed or consumed heads fail with `conversation_changed`. Refresh of the
same grant works; another grant, even for the same app, gains no ownership.
Restart recovery, durable ownership, pagination and interrupted-tool recovery
are not implemented. A browser can list after reload only while its original
grant and the proxy's in-memory registry are still live.

## Execution history, not an ordinary chat

Entries are `{ kind: "input" | "assistant", text }`. A native input may be a
learner prompt **or an application function output**, including native framing.
Show it as “Input (prompt or application output)”, never “You”. Do not infer
authorship from JSON, text patterns or the native owner marker. Tool-result
placeholders are omitted: stock can retain a delegated/pending placeholder even
after application output has arrived, so it is not reliable execution status.

The stock Responses implementation separates instructions into extra system
context but does not expose a join from its generated response ID to native
input-message IDs. Existing history metadata does not identify input kind.
A reliable per-message attribution index was therefore not added; this surface
does not claim a faithful human-chat projection. Reasoning, system/developer
messages, tool blocks and all native metadata/control fields are excluded by an
explicit allowlist. Only user/assistant text content is projected.

The read requests at most 200 native messages, limits each projected entry to
16,384 characters and the total to 131,072 characters. `truncated` reflects
upstream `hasMore` or local clipping. It is a bounded recent execution view, not
an export or a guarantee that the native transcript is complete.

Applications must restore their own matching book/UI context before continuing;
conversation IDs do not encode a book. History display must not execute tools.
The provider's future cache expiry and restart semantics are not recovery
guarantees. A failed continuation requires an explicit new conversation, not
automatic replay.

Verification: the deterministic real stock OpenClaw integration reads the native
history after two application-tool results, excludes supplied instructions,
refreshes the same grant and continues using the returned response head without
replaying either application action. In-process tests cover explicit projection,
bounded output, cross-grant isolation and head-consumption races.
