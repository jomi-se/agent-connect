# Current work

Updated: 2026-09-17

This is the canonical status page for unfinished work. Product boundaries live
in the [mission](../mission.md), capability status lives in the [scope
inventory](../scope-inventory.md), and accepted design decisions live in
[`docs/decisions/`](../decisions/). Completed implementation plans are indexed
in the [archive](../archive/README.md); they are not active instructions.

## Current release

Agent Connect is installed as the Agent Connect plugin for OpenClaw in the user's
OpenClaw process.
There is no separately operated Agent Connect proxy. The plugin owns a bounded
application-only listener on `127.0.0.1:18790` by default; native OpenClaw stays
on its own listener (the reference profile uses `127.0.0.1:18789`). Public
application routes remain under `/agent-connect`.

The published package versions are:

- `@open-agent-connect/web@0.0.9`;
- `@open-agent-connect/openclaw-plugin@0.0.7`.

The reference deployment pins the published plugin and its integrity, records
`listenPort: 18790`, and has passing smoke/fresh-target installation evidence.
The repository's reproducible host pin is OpenClaw `2026.9.1` on Node `>=24.15
<25`; the plugin permits that version or newer without an upper bound.

Setup and operations are documented in the [Agent Connect plugin for OpenClaw setup
guide](../../deploy/openclaw-gateway/README.md). The setup path is fresh: it
does not migrate provider credentials, owner identity, grants, conversations,
or refresh tokens from an older deployment.

## Acceptance and evidence

Deterministic installed-package tests cover the namespaced OAuth/Responses flow,
approved application tools under an inherited global tool profile,
continuation/history projection, refresh/revoke, native-tool denial,
disable/re-enable cleanup, unsafe-policy refusal, listener separation, and
native-owner coexistence. They use deterministic inference and are not
subscription-allowance evidence.

On 2026-09-09 the owner reported that the complete Bookhand vertical slice works
through the selected OpenClaw subscription runtime. This is owner-reported live
success, not an independently replayed certification of every browser,
provider, timeout, or edge-case behavior. The report is intentionally kept
separate from deterministic test evidence.

## Unfinished work

### Setup quality and visible product flow

The next product phase improves the owner and application experience around the
working Agent Connect plugin for OpenClaw vertical slice. These are proposed features, not release
gates or accepted architecture. Work them in this order:

1. [Owner console and managed agent profiles](../future/owner-console-and-profiles.md):
   the mobile-first owner authentication, consent, grant inspection, individual
   and bulk revocation, and browser-session management slice is implemented.
   Next, investigate a tasteful OpenClaw-native persistence boundary before
   adding owner-managed restricted profile editing.
2. [Firebase Canvas Agent Connect plugin migration](../future/firebase-canvas-plugin-migration.md):
   the polished workbench, deterministic three-scenario demo, and current
   address-based OAuth entry are implemented. Complete controlled live-plugin
   composition and the conversation/recovery acceptance matrix next.
3. [Provider-owned conversation recovery and library](../future/provider-owned-conversation-recovery.md):
   preserve enough provider provenance for applications to restore a valid
   conversation as it was presented, then expose an application-owned picker
   for active conversations without inventing a second transcript authority.
   [Trusted application identity, a browser-visible connection doctor, and
   bounded owner recovery controls](../future/setup-quality-candidates.md) are
   unprioritized adjacent candidates. Their briefs preserve the ideas without
   committing them to the sequence above.

### Legacy implementation cleanup

The runtime-card SDK, replacement gateway, replacement-engine tests, standalone
wrappers, and native OpenClaw patch experiment were removed on 2026-09-17 after
Canvas moved to the current address-based OAuth flow. Shared authorization,
grant, owner-console, and tool-snapshot code now belongs to the Agent Connect plugin
package. Historical rationale remains in Git and clearly marked archives; it is
not an active compatibility surface. On first load, the plugin converts its
immediately preceding combined version-2 auth file into owner-only state,
preserving the enrollment verifier and active `aco_` browser sessions while
discarding retired device keys and grants. Older standalone state formats are
not supported migration inputs.

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
