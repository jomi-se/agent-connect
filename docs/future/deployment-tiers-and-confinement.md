# Future task: deployment tiers and their confinement requirements

Status: discussion record, 2026-08-30. Nothing here is decided. It exists
because the reasoning was expensive to reach and was otherwise going to be lost
with a session.

Three deployment shapes have been assumed informally for a while:

| Tier | Shape                              | Who runs it | Who the user is                                     |
| ---- | ---------------------------------- | ----------- | --------------------------------------------------- |
| 1    | CLI gateway on a developer machine | The author  | A developer who accepted the blast radius knowingly |
| 2    | Packaged desktop app               | The user    | Non-technical; cannot reason about confinement      |
| 3    | Managed cloud                      | Us          | A tenant, on infrastructure they do not own         |

`docs/scope-inventory.md:54` still collapses all three into one
"General gateway deployment: Planned" row. Replacing that row with these three
is a reasonable follow-up, but it should happen after the open question below is
answered, not before.

## The starting position, and why it was wrong

The intuition going in was that confinement gets harder as you move up the
tiers: tier 1 is your own machine, tier 3 is hostile multi-tenancy. Two
corrections turned that ordering upside down.

### Correction 1: the credential problem is downstream of the nesting failure

The July sandbox spike recorded two independent failures. The one that reads as
most alarming is credential exposure: the dedicated Codex home holds a copied
`auth.json`, the outer sandbox shares host network, and the agent runs
`agent-full-access`. The spike's closing line is unambiguous — _"A copied
long-lived login inside the agent-visible home is not an acceptable production
boundary."_

That was initially ranked as the highest-leverage work in the program. It isn't,
because it is not independent of the _other_ failure. The agent runs
`agent-full-access` **because** Codex's own bubblewrap cannot nest inside
Omnigent's outer seccomp policy (`CLONE_NEW*` denied, `ENOSYS` for `clone3`,
`bwrap: No permissions to create new namespace`). Full access was the workaround
for the nesting denial. Fix the nesting and the reason for full access goes with
it.

So the containerized runner — already designed in
`docs/plan/containerized-gateway-deployment.md` — is not merely a packaging
convenience. It avoids nesting two bubblewrap policies rather than trying to
make them compose, which is the mechanism that is actually failing. It also
gives the MCP relay a reproducible dependency layout instead of a user-specific
mount, which is the leading (still unconfirmed) diagnosis of the second failure.

One change, three payoffs: tier 1's confinement, tier 2's installer, tier 3's
unit of tenancy.

### Correction 2: posture is a property of the grant, not of the tier

The second error was reading `mission.md`'s _"Require the selected runtime to
enforce an application-tools-only profile by default"_ as a claim about tier 2.
It is not. It is a claim about the **application principal** — what a
third-party origin gets when it holds a grant.

A desktop gateway serves two different kinds of session:

- **Owner-driven.** The user typing into their own app's window, asking for work
  on their own files. Filesystem, code execution, network. This is what Claude
  Cowork and ChatGPT agent mode are, and there is nothing wrong with it: the
  principal is the machine's owner.
- **App-driven.** A third-party web origin holding an OAuth grant. This is the
  adversarial principal `mission.md` names, and this is where
  application-tools-only belongs.

Same gateway, same runtime, different posture per grant. Per-grant scoping
already exists for exactly this. Tier 2 can therefore ship a real workspace —
the earlier claim that it could not was an over-read.

The cost of that correction: if the owner-driven path has a shell and a
filesystem, the read primitive is back, and credential brokering matters again
for that path specifically.

## The ordering inverts

Both major vendors solved the owner-driven surface with **a VM they control**.
Cowork now defaults to an isolated per-session sandbox on Anthropic's
infrastructure, created at session start and destroyed at the end. Local
execution on a Mac/Windows VM remains available, and is precisely where it went
wrong: the SharedRoot escape (July 2026) let Cowork break out of its local VM
and read host files and credentials on the Mac. The cloud default landed after
that research.

The vendor with the most resources in this space shipped
local-VM-with-real-filesystem to non-technical users, got a sandbox escape
reaching the host, and moved the default off the local machine.

Which gives the real ordering:

- **Tier 2 is the hardest confinement problem.** A sandbox escape lands in the
  user's actual home directory — SSH keys, browser profiles, `~/.aws`, and yes,
  `auth.json`. The blast radius is someone's whole life.
- **Tier 3 is the easiest on confinement.** A tenant escape reaches a disposable
  scratch workspace. It is harder _commercially_ — multi-tenancy, custodial
  credentials, the terms question — but not harder to contain.

Tier 3 being both the paid tier and the technically safer one is a coincidence
worth noticing, because the commercial and security arguments point the same way
for once.

## What is genuinely novel here, and it is not the exfiltration path

A fair objection: Codex wired to third-party MCP servers already has the full
lethal trifecta — credential access, untrusted content, an egress channel.
Agent Connect does not introduce a new vulnerability class. `auth.json` being
readable by the process that needs it is definitional.

That objection holds. What survives it is not a security claim but a **promise**
claim.

When you connect an MCP server to Codex, _you_ chose it, on your machine, as
someone able to evaluate what you are wiring in. Nothing displayed a boundary to
you, so nothing lied to you.

Agent Connect shows the user a consent screen with a bounded tool snapshot —
"this app may propose adding items to your shopping list." A user reading that
concludes the app received _those_ capabilities. Under `agent-full-access`, what
it actually received was the ability to steer an agent holding that user's
subscription credential. The exfiltration path is not novel; **the gap between
what the consent page promises and what the grant confers is.**

That is a broken promise rather than a new attack, and it is self-imposed —
nobody made us draw a consent screen. It also sharpens per tier: a developer
wiring MCP has an intuition about blast radius, a tier-2 desktop user has none
and cannot be given one through a checkbox, and a tier-3 tenant is not reasoning
about their own machine at all.

## Sequencing

1. **Containerized runner.** Fixes nesting, which lets application-tools-only
   actually run, which removes the read and exfiltration primitives on the
   app-driven path, which shrinks the credential problem to defence in depth.
2. **Honest posture reporting.** ADR 0008's machinery already covers it, and its
   rule — gateway-configured vs runtime-reported vs observed, never promoting a
   self-report to proof — is what makes shipping an unconfined tier 1
   defensible rather than negligent. Until the default posture holds, the
   consent page must not imply a boundary the runtime is not enforcing.
3. **Credential brokering.** For tiers 1 and 2 this is hardening against an
   injection that no longer has a read primitive on the app-driven path — but it
   stays load-bearing for the owner-driven path and for tier 3, where the
   custodial model changes from one user's credential on their own machine to
   many users' credentials on ours.
4. **Tier 3 specifics** — per-tenant scheduling, egress policy, abuse ceilings —
   only after a written answer on credentials and terms. That is a business
   decision, and it should not be allowed to shape architecture implicitly.

Also worth doing regardless: rerun the MCP relay diagnostic with the child's
stderr actually captured. The original run lost it to a zsh wrapper assigning to
the reserved `status` parameter. Not to fix the bwrap profile — to know whether
the container plan is right for the right reason.

## Open question

**Is the desktop app a competitor to Cowork with a lending feature, or a lending
gateway that happens to run locally?**

The differentiator is the app-driven surface: a third-party application
receiving a bounded, revocable, tool-snapshot-pinned grant against a runtime the
user owns. Neither Cowork nor agent mode offers that — they are chat products
with a workspace, not a capability the user can lend out to their shopping list.

If that is the product, then application-tools-only is not a limitation of tier
2, it _is_ tier 2. Owner-driven full access becomes table stakes you may want
for completeness, on the surface where the two largest vendors have more
resources and have just demonstrated that the local-VM problem is hard.

This is unanswered. It should be answered before the containerized runner is
built, because it decides whether that runner needs to host a workspace at all.

## References

- `docs/plan/containerized-gateway-deployment.md` — the design this argument
  converges on
- `docs/scope-inventory.md:54` — the row these three tiers would replace
- ADR 0008 — posture vocabulary and the honesty rule for evidence sources
- `mission.md` — "treat an authenticated application as an adversarial
  principal"; also lists resistance to subscription abuse as not yet claimed,
  which inverts at tier 3 from our concern about users to a provider's concern
  about us
- [Cowork architecture](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)
- [SharedRoot sandbox escape](https://labs.cloudsecurityalliance.org/research/csa-research-note-claude-cowork-sharedroot-sandbox-escape-20/)
- [Sandbox Agents, OpenAI](https://developers.openai.com/api/docs/guides/agents/sandboxes)
