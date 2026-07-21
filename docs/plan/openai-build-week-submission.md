# OpenAI Build Week submission guide

This document is the execution guide for presenting Agent Connect to OpenAI
Build Week. It does not replace the [current backlog](current-work.md), the
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
current Tailscale + Omnigent + Codex composition is the first working proof, not
the product boundary. Future adapters may reuse standard event and agent
vocabularies such as AG-UI and ACP where they fit, without presenting Agent
Connect's current custom bridge as an established standard.

The security ceremony is profile-dependent rather than mandatory everywhere.
A user controlling both a private application and gateway may preconfigure a
lighter trusted profile. Cross-origin, tunneled, shared, or public deployments
need stronger enrollment, consent, revocation, and usage controls. The demo
shows the stronger boundary because it is the reusable product case, not
because every personal shopping-list deployment needs OAuth-shaped ceremony.

Do not position the entry as half consumer app and half developer tool. Use one
clear hierarchy:

1. **Product:** a developer tool for connecting applications to user-owned
   agents through one harness-neutral application contract.
2. **Demonstration:** Firebase Canvas lends ten read/write tools across three
   example applications after gateway authentication and app consent.
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

The primary development session used `gpt-5.6-sol` and is recorded through the
required public `/feedback` identifier below.

This session contains the product and protocol investigation, architecture
choice, monorepo creation, adversarial plan review, Omnigent composition proof,
browser SDK, browser-to-Codex loop, tailnet gateway, Firebase Canvas, live
debugging, pairing and scoped-capability broker, and mutual-runtime-identity
follow-up. It encompasses the large majority of the core implementation and is
the strongest candidate for the required `/feedback` session.

The required `/feedback` upload has been completed. The identifier recorded in
the submission is:

`019f5c47-a462-73d0-a329-39013786bae4`

Do not expose the raw JSONL transcript publicly; it can contain more context
than the submission needs.

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

The repository includes an MIT license. If it remains private for judging,
verify access for both judge addresses above; if it becomes public, test an
unauthenticated clone from a clean context.

## Recommended three-minute demonstration

The guiding demonstration should make the application experience primary and
keep protocol internals in supporting narration. The current Canvas has three
example applications and ten typed tools, including a shared live-state read;
do not fall back to presenting the original `set_page_message` spike as the
product.

### Recording-day story

The shortest coherent story is:

1. **Problem and promise.** Open on the product sentence: Agent Connect lets a
   web developer add agent-powered features while the user brings a coding
   agent such as Codex. The application lends a narrow set of typed tools for a
   task instead of requiring a permanent application MCP installation.
2. **Connect once, separately from prompting.** Paste the public runtime card
   and start authorization. Explicitly point out that the runtime card is
   public but pins the gateway identity, while the enrollment passphrase is
   entered only on the gateway-owned HTTPS page and is never exposed to the
   application.
3. **Make consent legible.** Briefly show the gateway-owned consent surface:
   application identity and Origin, callback, expiry, and the exact tools being
   requested. State plainly that authorization grants capability; it cannot
   make an untrusted application trustworthy.
4. **Show a useful application mutation.** Use one of the richer demo apps—
   project-board bulk editing, in-place document review, or product research—
   and send its prepared prompt. Keep the live request/tool/result animation in
   frame long enough to show that the coding-agent side asks for app-owned
   operations and the page executes them visibly.
5. **Show that authority remains controllable.** Open the gateway grant list,
   revoke the application, and show that the old capability can no longer
   create an agent session. This is the clearest compact proof that the gateway
   is more than a transport proxy.
6. **Close on the boundary and direction.** Web applications integrate the
   provider-neutral SDK; users run the security gateway at their own boundary;
   Omnigent plus ACP is the first adapter, not the public API. The north star is
   swappable agents, harnesses, and deployment profiles without rewriting the
   application integration.

### Required honesty about the two proofs

The public judge demo uses a deterministic ACP agent fixture so judges can
run the full authorization, Omnigent, ACP, request-scoped MCP, browser-tool, and
page-mutation path without consuming a model account. Its three action plans
were authored from real Codex interactions, but the public fixture must not be
described as live model reasoning.

Separately, the private composition proof completed the same browser-to-tool
loop with a real Codex session behind Omnigent. If footage or a concise capture
of that run is available, use it to establish that the adapter works with the
real agent; then use the deterministic public profile for the reproducible
judge experience. Label the transition clearly rather than visually blending
the two.

### How Codex and GPT-5.6 were used

Do not reduce this to “Codex generated the code.” The concrete development
story is stronger:

- the project was designed and implemented through the primary Codex build
  thread, recorded as `gpt-5.6-sol` across its turn contexts;
- Codex researched Omnigent and ACP, shaped the agent-neutral boundary, created
  the monorepo, implemented the browser SDK and gateway, wrote tests, and
  debugged the real browser → Omnigent → Codex → browser-tool loop;
- during the public-Funnel design, a delegated Codex audit treated the transport
  change as a trust-boundary substitution and discovered that `/v1/grants`
  listing and revocation could otherwise become anonymously reachable;
- the primary Codex pass confirmed the source path, implemented the enrolled-
  device requirement, and added regression coverage; and
- the human builder chose the product direction, challenged excessive scope and
  security claims, tested the real mobile flow, and retained the final design
  and release decisions.

That route finding is a particularly good on-screen engineering artifact. Show
the concise discovery chain or the regression test—not the generic agent skill
files. The durable account is in
[the grant-route security retrospective](grant-route-security-retrospective.md).

The video should show a real working path, not become an architecture
slideshow. Use the polished diagrams and terminal animation only to orient the
viewer around observable behavior. Cut typing, loading, and setup time before
cutting the authorization decision, tool request, visible mutation, or
revocation result.

## Judging strategy

### Technological Implementation

Demonstrate the browser-safe SDK, fixed typed tool snapshot, correlated tool
results, opaque application sessions, scoped capability, provider adapter, and
live Codex round trip. Clearly distinguish implemented behavior from planned
durability work.

### Design

Treat this as the highest-risk criterion. Runtime-card import, enrollment,
consent, progress, completion, and revocation must feel like one coherent
product experience. Judges should not need to understand Omnigent, ACP, MCP, SSE, or
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

## Project-description outline

The final Devpost description should be written in the entrant's own voice.
Use the questions and evidence below as scaffolding rather than copying them as
submission prose.

### Inspiration

- What happens when a small app developer wants an AI feature today?
- Why are both developer-funded API usage and conventional BYOK awkward for a
  shopping list, project board, text editor, or other ordinary application?
- What changed once coding agents became part of subscriptions people already
  use?
- State the personal origin honestly: this began as a way to let a remotely
  running Codex improve the entrant's shopping-list application.

### What it does

- A web app declares narrow, typed operations and their browser-side handlers.
- A user connects a gateway they run at their own boundary.
- The user sees the exact application Origin and requested tools before
  granting access.
- The app can send a prompt; the coding agent reads current app state and calls
  those app-owned tools; visible changes happen inside the page.
- No app-specific MCP server has to be installed into the coding agent first.
- Name the three demo surfaces: project-board editing, document review, and
  product research.

### How it was built

- Browser-safe TypeScript SDK: tool declarations, runtime-card verification,
  authorization redirect, sessions, streamed events, and correlated tool
  results.
- User-owned gateway: durable identity, enrollment, consent, origin- and
  tool-bound grants, opaque sessions, revocation, and provider isolation.
- Current real-agent composition: Tailscale Serve, Agent Connect gateway,
  Omnigent, ACP, `codex-acp`, Codex, and a request-scoped MCP relay back to the
  browser.
- Public judge composition: the same boundaries with a deterministic ACP
  fixture replaying Codex-authored plans, clearly labelled as deterministic.
- Separate implemented behavior from intended adapters and deployment
  profiles.

### Challenges

- Dynamically lending tools to an already-running coding-agent setup without
  preinstalling one MCP per application.
- Distinguishing two directions of trust: the gateway must authorize the app,
  and the app must verify that it reached the user's enrolled gateway.
- Keeping the enrollment passphrase on the gateway-owned Origin so the app can
  never read it.
- Healing downstream sessions when the immutable tool snapshot changes.
- Making the public demo reproducible without exposing or spending a personal
  Codex subscription.
- Finding and fixing the anonymous grant-list/revocation route when moving from
  a private Tailscale profile to a public Funnel profile.

### Accomplishments

- A real browser to gateway to Omnigent to Codex to browser-tool round trip
  works.
- An arbitrary web Origin can enroll through the authorization flow instead of
  being configured in advance.
- The judge demo survives VM restarts and needs no judge installation or paid
  model account.
- The browser SDK and real gateway can also be installed from source for a
  third-party integration test.
- Fast gateway behavior tests and an Omnigent integration layer exercise the
  authentication and orchestration boundaries without paying for model calls.

### What Codex and GPT-5.6 contributed

- Mention the primary `gpt-5.6-sol` build thread and `/feedback` identifier.
- Give concrete examples: protocol research, boundary design, SDK and gateway
  implementation, tests, live debugging, security review, and documentation.
- Include the grant-route finding as one specific example of Codex improving
  the implementation rather than merely generating boilerplate.
- Preserve the human decisions: choosing the product problem, challenging
  over-engineering, narrowing the demo, testing on mobile, and deciding which
  security claims were honest.

### What comes next

- Keep the application contract stable while making agents, conductors,
  transports, and deployment profiles swappable.
- Explore standardized event and agent adapters such as AG-UI and ACP without
  claiming the current bridge is already a universal standard.
- Improve packaging, sandbox guidance, durability, and npm distribution.
- Return to the original shopping-list integration after the hackathon.

### Closing test

After writing, verify that a judge can answer these four questions without
reading the repository:

1. Who has this problem?
2. What visibly works today?
3. Why is this different from an API key or a permanent MCP installation?
4. Which parts are the current proof, and which parts are the longer-term
   direction?

## Work remaining before submission

The implementation, MIT license, source-installable real gateway, packaged SDK
test path, deterministic public demo, `/feedback` upload, and edited video are
complete. The remaining work is submission packaging and release operation:

1. Ensure the YouTube URL already stored in the Devpost draft serves the edited
   2:54 cut: trim the existing upload in YouTube Studio or upload the edited
   file and replace the URL. Confirm that it is public.
2. Choose and upload the 3:2 thumbnail and gallery images, then write the
   project description from the outline above in the entrant's own voice.
3. Recheck the private judge instructions from a clean browser: runtime card,
   gateway-only passphrase entry, one rich Canvas task, grant revocation,
   logout, and reconnect.
4. Confirm repository access, public demo health, YouTube visibility, all live
   fields, and the submitted state before `2026-07-22T00:00:00Z`.
5. Keep the judge demo available through `2026-08-06T00:00:00Z`, then use
   its documented Funnel kill switch and destroy its disposable credentials.

Do not present pending-action durability, a hardened real-agent sandbox, npm
publication, AG-UI, or additional providers as completed behavior.

## Final verification

Run the repository gate immediately before recording and again before
submission:

```sh
npm run verify:full
npm run test:integration:omnigent
```

Also perform a fresh real-browser run using the exact judge instructions. Check
that the repository or private-repository access, demo URL, credentials,
YouTube visibility, `/feedback` identifier, and Devpost submission state all
work from a clean context.
