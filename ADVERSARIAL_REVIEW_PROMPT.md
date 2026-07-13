# Adversarial Review: Agent Connect Hackathon Plan

You are performing a clean, skeptical second-pass review of the current repository plan and architecture.

Important execution constraints:

- Do not use the `adversarial-review` skill.
- Do not use `adversarial-review-execute` again.
- Do not create or rewrite this prompt.
- Do not launch another subprocess, wrapper, subagent, or additional clean review.
- Inspect the repository directly and write the final review only.
- Do not modify the implementation or planning documents under review.
- Create or replace the repo-root file `ADVERSARIAL_REVIEW_OUTPUT.md` using normal file-editing tools.
- After writing it, reopen it and verify that it is complete and readable.
- Your final chat response must be only a short completion status; the full review belongs in `ADVERSARIAL_REVIEW_OUTPUT.md`.

## Review target

Adversarially review the committed Agent Connect hackathon direction, with emphasis on:

- `README.md`
- `AGENTS.md`
- `USER_OWNED_AGENT_RUNTIME_HACKATHON_HANDOFF.md`
- `docs/mission.md`
- `docs/scope-inventory.md`
- `docs/architecture/target-architecture.md`
- `docs/architecture/narrow-protocol-profile.md`
- `docs/decisions/0001-acp-first-application-boundary.md`
- `docs/decisions/0002-omnigent-conductor.md`
- `docs/plan/hackathon.md`
- `docs/research/2026-07-13-landscape.md`
- `packages/web-sdk/**`
- root workspace and verification configuration

The current thesis is broadly: expose an ACP-first public application boundary; make the first deliverable a browser SDK containing a narrow, single-session, single-server MCP-over-ACP implementation; fork or adapt OmniGENT as the conductor/gateway; use the maintained Codex ACP adapter downstream; and retain a Codex app-server provider as a fallback. The defining product requirement is that applications can define session tools dynamically and the user's agent can call them without the user preinstalling an MCP server.

## Review goal

Try to disprove that this is the best credible hackathon plan. Find architectural contradictions, hidden integration work, unsupported assumptions, incorrect dependency ordering, premature implementation, missing product/security constraints, and places where the plan can be substantially simplified. Then propose specific improvements that preserve the product insight where possible.

Do not merely restate tradeoffs already documented. Inspect source and tests closely enough to distinguish a real mitigation from a placeholder.

## Questions that must be answered

1. Does OmniGENT actually remove more work than it adds for this narrow demo, especially when acting as an upstream ACP edge and a downstream ACP client?
2. Is the complete intended call path technically coherent: browser app tool definition -> MCP-over-ACP -> conductor -> Codex ACP adapter -> Codex tool call -> application result -> same Codex turn completion?
3. Which links in that path are demonstrated by repository evidence, which are supported only by external research, and which remain conjecture?
4. Does the existing generic ACP/request-supplied-tool behavior in OmniGENT plausibly compose with the maintained Codex ACP adapter, or is the plan joining two individually plausible features that do not actually meet?
5. Is ACP the right public boundary now, given unstable MCP-over-ACP and WebSocket support? Is the narrow profile sufficiently versioned and isolated to survive protocol drift?
6. Does the browser SDK encode unstable protocol types too early or leak conductor-specific behavior into what claims to be a harness-agnostic API?
7. Are reconnect, pending-request persistence, result claiming, cancellation, duplicate execution, and idempotency specified enough for the promise being made? What durability should be explicitly deferred for the hackathon?
8. Are authentication, authorization, origin binding, permission UX, tool-schema trust, malicious tool results, resource limits, and session ownership handled at the right level?
9. Does the milestone sequence retire the highest-risk assumptions first? Are the go/no-go criteria objective and early enough?
10. Is the fallback to direct Codex app-server realistic, or does maintaining two conductor paths expand scope without buying credible schedule protection?
11. Is this differentiated enough for a Build with Codex hackathon, or does it risk looking like protocol plumbing around existing clients? What demo story best exposes the unique value?
12. What should be deleted, deferred, or renamed to make the project more believable and finishable?
13. If OmniGENT is the wrong base, what is the strongest concrete counterproposal, and what capabilities would be lost?
14. Are package boundaries, tests, evidence contracts, and repository structure adequate for the next implementation phase?

## Required output structure

Write `ADVERSARIAL_REVIEW_OUTPUT.md` with:

1. **Verdict** — a concise overall judgment: proceed, proceed only after changes, or reject current plan.
2. **Critical findings** — prioritized `P0`, `P1`, and `P2`. Each finding must include:
   - the claim or decision under challenge;
   - concrete repository evidence with file and line references where possible;
   - why it matters to delivery or product credibility;
   - a specific corrective action.
3. **Assumption ledger** — classify important links as proven in this repo, externally supported but unproven here, or conjectural.
4. **Recommended architecture** — the smallest credible target architecture, including whether OmniGENT remains, is reduced to an experiment, or is removed.
5. **Revised execution plan** — ordered milestones with explicit exit criteria, beginning with the fastest experiment that can kill the plan.
6. **Delete/defer list** — scope and claims that should not be in the hackathon critical path.
7. **Demo and judging strategy** — how to make the Codex-specific value visible rather than presenting generic protocol infrastructure.
8. **Strongest alternative** — a concrete no-OmniGENT design and a fair comparison.
9. **Proposed documentation edits** — a concise file-by-file change list; do not make those edits yourself.

Be demanding but practical. Prefer a smaller plan with decisive evidence over a broad architecture with speculative compatibility.
