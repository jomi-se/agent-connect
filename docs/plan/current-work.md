# Current work

Updated: 2026-09-09

This is the canonical status page for unfinished work. Product boundaries live
in the [mission](../mission.md), capability status lives in the [scope
inventory](../scope-inventory.md), and accepted design decisions live in
[`docs/decisions/`](../decisions/). Completed implementation plans are indexed
in the [archive](../archive/README.md); they are not active instructions.

## Current release

Agent Connect is installed as a plugin in the user's stock OpenClaw process.
There is no separately operated Agent Connect proxy. The plugin owns a bounded
application-only listener on `127.0.0.1:18790` by default; native OpenClaw stays
on its own listener (the reference profile uses `127.0.0.1:18789`). Public
application routes remain under `/agent-connect`.

The published packages are:

- `@open-agent-connect/web@0.0.4`;
- `@open-agent-connect/openclaw-plugin@0.0.2`.

The reference deployment pins the published plugin and its integrity, records
`listenPort: 18790`, and has passing smoke/fresh-target installation evidence.
The repository's reproducible host pin is OpenClaw `2026.9.1` on Node `>=24.15
<25`; the plugin permits that version or newer without an upper bound.

Setup and operations are documented in the [stock OpenClaw setup
guide](../../deploy/openclaw-gateway/README.md). The setup path is fresh: it
does not migrate provider credentials, owner identity, grants, conversations,
or refresh tokens from an older deployment.

## Acceptance and evidence

Deterministic installed-package tests cover the namespaced OAuth/Responses flow,
approved application tools, continuation/history projection, refresh/revoke,
native-tool denial, disable/re-enable cleanup, unsafe-policy refusal, listener
separation, and native-owner coexistence. They use deterministic inference and
are not subscription-allowance evidence.

On 2026-09-09 the owner reported that the complete Bookhand vertical slice works
through the selected OpenClaw subscription runtime. This is owner-reported live
success, not an independently replayed certification of every browser,
provider, timeout, or edge-case behavior. The report is intentionally kept
separate from deterministic test evidence.

## Unfinished work

### Setup quality and visible product flow

The next product phase improves the owner and application experience around the
working stock-plugin vertical slice. These are proposed features, not release
gates or accepted architecture. Work them in this order:

1. [Owner console and managed agent profiles](../future/owner-console-and-profiles.md):
   replace the raw enrollment and consent presentation with a mobile-first,
   familiar OAuth flow and investigate a tasteful OpenClaw-native persistence
   boundary for owner-managed restricted profiles.
2. [Firebase Canvas stock-plugin migration](../future/firebase-canvas-plugin-migration.md):
   turn the historical Canvas into both a polished public demonstration and a
   readable reference application using the current address-based OAuth flow.
3. [Provider-owned conversation recovery and library](../future/provider-owned-conversation-recovery.md):
   preserve enough provider provenance for applications to restore a valid
   conversation as it was presented, then expose an application-owned picker
   for active conversations without inventing a second transcript authority.
   [Trusted application identity, a browser-visible connection doctor, and
   bounded owner recovery controls](../future/setup-quality-candidates.md) are
   unprioritized adjacent candidates. Their briefs preserve the ideas without
   committing them to the sequence above.

### Legacy implementation cleanup (owned separately)

Canvas/runtime-card migration and removal of the older gateway implementation
remain pending, not plugin-release gates. The Canvas migration now has a
[focused brief](../future/firebase-canvas-plugin-migration.md); do not remove
shared modules or the older gateway while it still consumes them.
Retain shared modules and existing consumers until their replacements land.
The native OpenClaw patch experiment and its obsolete build/probe wiring also
remain cleanup targets; do not confuse them with the separately required AI SDK
patch. Archive their contracts and evidence as consumers are retired.

### Personal deployment metadata and shared-history cleanup

The owner's 2026-09-06 request remains pending: remove personal deployment
identifiers from tracked configuration and inventory affected history/refs.
Use explicit local configuration rather than weakening host checks. Coordinate
other branches and preserve a private recovery backup before any history rewrite.
Rewriting shared history or force-pushing requires separate explicit owner
approval; this documentation pass does neither. Previously cleaned unpublished
commits do not establish that shared ancestors, cached views, or forks are clean.

### Bookhand/provider defects

These are known follow-up defects; they do not reopen the plugin migration and
must not trigger automatic action replay:

- Search indexing can fail on an unstable Section 2 anchor in the difficult
  EPUB; tool and Tutor feedback should distinguish failed, not-started, and
  progress states.
- An unavailable search should be explained rather than triggering an
  unsolicited source scan or repair attempt.
- Navigation can emit mutually exclusive fields despite its prose; investigate
  the provider schema transformation that removes `oneOf`.
- Surface the confirmed runtime timeout instead of an unknown-error message.

### Deferred review debts (not gates)

The following two bounded technical debts were explicitly deferred on
2026-09-09. They are not publication, installation, or acceptance gates:

- Exclude private `listenPort` from the delegated-policy fingerprint while
  retaining invalidation for public-origin and policy changes. Until a focused
  regression exists, changing only the private port may require reconnecting
  and consent.
- Tighten doctor readiness identification so a stale service returning HTTP 200
  cannot be mistaken for the configured instance. This is diagnostic accuracy,
  not an authorization bypass; occupied-port startup already fails.

### Durable history boundary

Conversation/checkpoint ownership is process-local and bounded. Restart, disable,
or expiry ends continuation; an ambiguous application effect is never replayed.
Persisting ownership across host restart, reopening after the native Responses
cache expires, and any safe interrupted-turn recovery require a separately
reviewed decision and are not part of this release.

## Deliberately out of scope

Do not add a generalized multi-agent orchestrator, arbitrary MCP surface,
Android automation, second proprietary session protocol, public multi-tenancy,
billing, hosted relay, or native-client identity profile as routine cleanup.
The [north star](../vision.md) records longer-term product direction; it does
not expand this release's implementation scope.

## Historical material

The [archive index](../archive/README.md) records completed and superseded plans,
including the standalone replacement implementation, dedicated-listener and
guided-setup execution ledgers, the release/deployment handoff, and the Open
Responses vertical-slice plan. Their dated evidence and rationale remain useful;
their old gates and commands are not current instructions.
