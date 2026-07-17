# OpenAI Build Week submission guide

This document is the execution guide for presenting Agent Connect to OpenAI
Build Week. It does not replace the [implementation plan](hackathon.md), the
[mission](../mission.md), or the
[official hackathon rules](https://openai.devpost.com/rules).

Rule and submission details below were checked through the Devpost Hackathons
plugin again at 2026-07-14 23:35 UTC. The timestamped structured refresh,
including live field IDs, is in
[`2026-07-14-openai-build-week-refresh.md`](../research/2026-07-14-openai-build-week-refresh.md).
Recheck the official rules and recent announcements before submitting.

## Submission decision

Submit Agent Connect to the **Developer Tools** category.

Agent Connect is a developer SDK and gateway that let an application use an
agent running in the user's environment while lending that agent temporary,
typed application capabilities. Firebase Canvas is the coherent implemented
demonstration. The spreadsheet is a stronger follow-up only if its durability
and approval behavior are actually completed.

The north star is broader than the demonstrated deployment: applications
integrate once against a harness-neutral capability-lending contract, while the
user chooses an agent runtime and an appropriate provisioning profile. The
current Tailscale + OmniGENT + Codex composition is the first working proof, not
the product boundary. Future adapters may reuse standard event and agent
vocabularies such as AG-UI and ACP where they fit, without presenting Agent
Connect's current custom bridge as an established standard.

The security ceremony is profile-dependent rather than mandatory everywhere.
A user controlling both a private application and connector may preconfigure a
lighter trusted profile. Cross-origin, tunneled, shared, or public deployments
need stronger enrollment, consent, revocation, and usage controls. The demo
shows the stronger boundary because it is the reusable product case, not
because every personal shopping-list deployment needs OAuth-shaped ceremony.

Do not position the entry as half consumer app and half developer tool. Use one
clear hierarchy:

1. **Product:** a developer tool for connecting applications to user-owned
   agents through one harness-neutral application contract.
2. **Demonstration:** Firebase Canvas lends one visible page-mutation tool to
   the user's Codex agent after connector authentication and app consent.
3. **End-user benefit:** useful agent behavior inside an application without
   exposing raw provider session identifiers or requiring an application MCP
   server to be installed in advance.
4. **Direction:** additional runtime adapters and provisioning profiles can
   preserve the application integration while changing the underlying agent,
   transport, or deployment posture.

Suggested short description:

> Agent Connect lets any web application borrow intelligence from an agent
> running in the user's own environment. The application lends temporary,
> typed capabilities to the agent; the user can inspect and approve
> consequential actions; and provider-specific sessions remain behind the
> gateway.

This is framing material, not submission-ready prose. The entrant should
rewrite the final description in their own voice.

Keep reliability claims exact. Stable action IDs and application-owned
deduplication can prevent the demonstrated write from being applied twice;
Agent Connect does not provide generic exactly-once side effects.

## Deadline and eligibility evidence

The official submission deadline is **2026-07-21 at 5:00 PM Pacific Time**
(`2026-07-22T00:00:00Z`). A Devpost announcement incorrectly called July 21 a
Monday; use the date and timestamp in the formal rules and submission page.

The submission period began at **2026-07-13 at 9:00 AM Pacific Time**
(`2026-07-13T16:00:00Z`). The repository's first commit is timestamped
`2026-07-13T17:15:48Z`, so the current repository history begins after the
submission window opened. Preserve the dated commit history as evidence.

Before submission, the entrant must independently confirm the official age,
country or territory, employment, conflict-of-interest, ownership, and
third-party-license requirements. Do not treat this guide as an eligibility
determination.

## Primary Codex build session

The primary development session is:

- Codex session UUID: `019f5c47-a462-73d0-a329-39013786bae4`
- Started: `2026-07-13T16:20:26Z`
- Last activity: `2026-07-14T06:42:48Z`
- Recorded model: `gpt-5.6-sol` across all 35 turn contexts
- Working directory: `/home/dev/agent-connect`

This session contains the product and protocol investigation, architecture
choice, monorepo creation, adversarial plan review, OmniGENT composition proof,
browser SDK, browser-to-Codex loop, tailnet gateway, Firebase Canvas, live
debugging, pairing and scoped-capability broker, and mutual-runtime-identity
follow-up. It encompasses the large majority of the core implementation and is
the strongest candidate for the required `/feedback` session.

The raw local UUID should not be assumed to replace the hackathon's `/feedback`
workflow. Resume the original session and run `/feedback` there:

```sh
codex resume 019f5c47-a462-73d0-a329-39013786bae4
```

Then enter `/feedback` in the resumed Codex session and copy the identifier it
displays into the Devpost submission. Preserve a screenshot or note of the
result. Do not expose the raw JSONL transcript publicly; it can contain more
context than the submission needs.

## Required submission materials

Before submitting, confirm all of the following against the live Devpost form:

- a working project that runs as described;
- Developer Tools selected as the single category;
- an edited project description explaining the problem, audience, behavior,
  and demonstrated result;
- a public YouTube demo shorter than three minutes;
- voiceover explaining what was built and how both Codex and GPT-5.6 were used;
- a public repository with an appropriate open-source license, or a private
  repository shared with `testing@devpost.com` and
  `build-week-event@openai.com`;
- a README with setup instructions, supported platforms, sample data where
  needed, and a reproducible test path;
- a README section describing collaboration with Codex, the decisions retained
  by the human builder, and GPT-5.6's contribution;
- the `/feedback` identifier from the primary build session;
- installation and testing instructions specifically for the developer tool;
- a free judge-accessible demo, sandbox, test build, or test account available
  through the end of judging at **2026-08-06 00:00 UTC** (August 5 at 5:00 PM
  Pacific Time);
- all required team members and submission fields; and
- a final submitted state rather than a saved draft.

If the repository is public, add and verify a suitable license before
submission. At the time this guide was written, no repository license file was
present.

## Recommended three-minute demonstration

The guiding demonstration should make the application experience primary and
keep protocol internals in supporting narration.

1. Paste the public runtime card into Firebase Canvas; explicitly show that the
   enrollment secret is not app input.
2. Start authorization and show that the connector proves its pinned identity
   before the app sends tool metadata.
3. On the connector-owned page, show the app origin, callback, expiry, required
   scopes, and `set_page_message` schema; enter the saved enrollment secret
   only if this is the first device, then approve.
4. Return through PKCE and ask Codex for a short welcome message.
5. Show the streamed run, application tool request, and visible page mutation.
6. Open the connector grant list, revoke Canvas, and show that the existing
   capability can no longer reach the agent.
7. End on the simple architecture: neutral web SDK, security gateway,
   OmniGENT adapter, and Codex/GPT-5.6.

The video should show a real working path, not architecture slides. A brief
closing diagram may explain that the application-facing API remains
provider-neutral while OmniGENT and Codex are behind adapters. Cut typing,
loading, and setup time before cutting observable product behavior.

## Judging strategy

### Technological Implementation

Demonstrate the browser-safe SDK, fixed typed tool snapshot, correlated tool
results, opaque application sessions, scoped capability, provider adapter, and
live Codex round trip. Clearly distinguish implemented behavior from planned
durability work.

### Design

Treat this as the highest-risk criterion. Runtime-card import, enrollment,
consent, progress, completion, and revocation must feel like one coherent
product experience. Judges should not need to understand OmniGENT, ACP, MCP, SSE, or
the internal session mapping to understand the result.

### Potential Impact

Name the first audience precisely: web-application developers who want to add
agentic workflows backed by an agent in the user's environment. Demonstrate how
the SDK reduces integration work and preserves explicit application ownership
of consequential operations. Make the interoperability direction explicit:
the application should not need a bespoke integration for every agent harness
or deployment profile. Avoid unsupported market-size, privacy, security, or
universal-protocol claims.

### Quality of the Idea

Lead with the direction of capability lending: the application temporarily
lends typed tools to the user's agent. Contrast it factually with preinstalling
a permanent application MCP server or exposing raw provider sessions, without
claiming those approaches are always wrong.

## Work remaining before submission

Prioritize product completion over additional protocol generalization:

1. Deploy and validate the runtime-card/passphrase/PKCE flow from the real
   Firebase origin on a phone. Capture the app origin, connector origin,
   consent, redirect, tool request, page mutation, grant list, and revocation.
2. Use the proven OmniGENT runtime for the recorded demo unless the experimental
   bwrap MCP startup gap is fixed and revalidated end to end.
3. Freeze the smallest coherent demo. Prefer the Canvas authorization/tool/
   revoke story if spreadsheet durability is not complete; do not show planned
   recovery as working.
4. Provide the isolated [judge demo environment](judge-demo-environment.md)
   through public Tailscale Funnel. It must not depend on membership in the
   developer's tailnet, require rebuilding, or reuse the personal connector and
   Codex login.
5. Make the downstream GPT-5.6 runtime choice and its role observable and
   documented; do not rely only on hidden session metadata.
6. Add the required submission-oriented README material, supported-platform
   matrix, sanitized evidence, one-command judge test, and repository license.
7. Run `/feedback` in the primary build session and fill live fields
   27945–27951 as applicable.
8. Record the public narrated demo under three minutes, re-fetch announcements
   and requirements, and verify the submitted state before
   2026-07-22 00:00 UTC.

The current Firebase Canvas and browser-to-Codex path are valid technical
evidence, but they should not be presented as completion of the pending-action
and spreadsheet milestones. If those milestones remain incomplete at the
deadline, narrow the video and description to behavior that has actually
passed.

## Final verification

Run the repository gate immediately before recording and again before
submission:

```sh
npm run verify
```

Also perform a fresh real-browser run using the exact judge instructions. Check
that the repository or private-repository access, demo URL, credentials,
YouTube visibility, `/feedback` identifier, and Devpost submission state all
work from a clean context.
