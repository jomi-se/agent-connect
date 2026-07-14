# OpenAI Build Week submission guide

This document is the execution guide for presenting Agent Connect to OpenAI
Build Week. It does not replace the [implementation plan](hackathon.md), the
[mission](../mission.md), or the
[official hackathon rules](https://openai.devpost.com/rules).

Rule and submission details below were checked through the Devpost Hackathons
plugin on 2026-07-14. Recheck the official rules and recent announcements before
submitting.

## Submission decision

Submit Agent Connect to the **Developer Tools** category.

Agent Connect is a developer SDK and gateway that let an application use an
agent running in the user's environment while lending that agent temporary,
typed application capabilities. The spreadsheet application is the clearest
demonstration of the developer tool; it is not the product category itself.

Do not position the entry as half consumer app and half developer tool. Use one
clear hierarchy:

1. **Product:** a developer tool for connecting applications to user-owned
   agents.
2. **Demonstration:** a spreadsheet application that lends scoped range tools
   to the user's Codex agent.
3. **End-user benefit:** useful agent behavior inside an application without
   exposing raw provider session identifiers or requiring an application MCP
   server to be installed in advance.

Suggested short description:

> Agent Connect lets any web application borrow intelligence from an agent
> running in the user's own environment. The application lends temporary,
> typed capabilities to the agent; the user can inspect and approve
> consequential actions; and provider-specific sessions remain behind the
> gateway.

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
  through the end of judging;
- all required team members and submission fields; and
- a final submitted state rather than a saved draft.

If the repository is public, add and verify a suitable license before
submission. At the time this guide was written, no repository license file was
present.

## Recommended three-minute demonstration

The guiding demonstration should make the application experience primary and
keep protocol internals in supporting narration.

1. Open a spreadsheet containing inconsistent data.
2. Pair the web application with the user's Agent Connect runtime.
3. Ask Codex to clean the table, normalize categories, and flag suspicious
   rows.
4. Show Codex inspecting the sheet through temporary `get_selection` and
   `read_range` capabilities.
5. Show a preview of a proposed mutation and obtain visible approval.
6. Apply the spreadsheet change.
7. Deliberately disconnect while a second write is pending.
8. Reconnect, resurface the unresolved action, and complete it without applying
   the demonstrated mutation twice.
9. End on the changed sheet, concise audit trail, and final agent explanation.

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

Treat this as the highest-risk criterion. Pairing, progress, approval,
disconnect, recovery, and completion must feel like one coherent product
experience. Judges should not need to understand OmniGENT, ACP, MCP, SSE, or
the internal session mapping to understand the result.

### Potential Impact

Name the first audience precisely: web-application developers who want to add
agentic workflows backed by an agent in the user's environment. Demonstrate how
the SDK reduces integration work and preserves explicit application ownership
of consequential operations. Avoid unsupported market-size, privacy, security,
or universal-protocol claims.

### Quality of the Idea

Lead with the direction of capability lending: the application temporarily
lends typed tools to the user's agent. Contrast it factually with preinstalling
a permanent application MCP server or exposing raw provider sessions, without
claiming those approaches are always wrong.

## Work remaining before submission

Prioritize product completion over additional protocol generalization:

1. Complete durable pending-action recovery and the spreadsheet demonstration
   in [the implementation plan](hackathon.md).
2. Provide a judge-accessible testing path that does not depend on membership in
   the developer's tailnet and does not require rebuilding the project.
3. Make the downstream GPT-5.6 runtime choice and its role observable and
   documented; do not rely only on hidden session metadata.
4. Add the required submission-oriented README material and repository license.
5. Record the demo as the product stabilizes, then produce the final concise
   cut.

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
