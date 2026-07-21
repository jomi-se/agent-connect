# Using frontier coding agents to remove AI-generated codebase debt

Date: 2026-07-21

Status: research synthesis and proposed working method; not yet an Agent Connect
execution plan.

## Question

How should a team use current frontier coding agents to improve a codebase that
was itself built rapidly with coding agents? The goal is not cosmetic cleanup.
It is to recover a system that is easier for humans and agents to understand,
safer to change, smaller where possible, and still behaviorally correct.

This note prioritizes evidence published between March and July 2026. The field
is young: several of the strongest results are preprints, most experiments cover
only a few languages or repositories, and no study establishes a universal
autonomous cleanup recipe.

## Executive conclusion

Frontier agents look useful as **high-throughput refactoring implementers and
investigators**, but are still weak as unsupervised architectural judges.

The best-supported workflow is:

1. establish the behavior and security contract before changing structure;
2. combine deterministic analysis with an agent-written system map;
3. make the agent propose concrete refactors before it edits;
4. have a human or independent reviewer select and sharpen the proposal;
5. implement one narrow structural change at a time;
6. verify public behavior, search for missed call sites and dead leftovers, and
   review the diff before merging;
7. encode each accepted lesson into tests, static rules, or repository guidance
   so the codebase does not immediately regress.

The unsupported version is one large prompt saying “clean up this repository.”
That asks the model to discover the architecture, choose the tradeoffs, edit a
large dependency surface, and certify its own work in one pass. Current evidence
suggests that discovery and compound refactoring are precisely where agents are
least reliable.

## What recent evidence says

### Detailed refactoring instructions beat vague cleanup prompts

[CodeTaste](https://codetaste.logicstar.ai/) evaluates large real-world
refactorings across 100 instances from 87 repositories and six languages. The
median instance changes 73 files and 1,515 lines. Frontier agents reached up to
69.6% alignment when given a detailed refactoring specification, but the best
direct result was only 7.9% when the agent received an underspecified area to
improve and had to discover the intended refactor itself.

A propose-then-implement decomposition improved the open-ended result. Selecting
the best of several proposals before implementation improved it further, though
the reported 20.6% used an oracle selector and should not be mistaken for a
fully autonomous production workflow. The practical lesson is still strong:
separate architectural diagnosis from mutation, and spend judgment on selecting
the change before spending tokens implementing it.

### Compound refactors remain substantially harder than atomic ones

[SWE-Refactor](https://arxiv.org/abs/2602.03712) contains 1,099
developer-written, behavior-preserving refactors from 18 Java repositories. It
finds that complex and compound refactorings are the main failure source; the
evaluated Codex agent succeeded on only 39.4% of compound instances. The models
and benchmark are not a direct measurement of the current Agent Connect stack,
but they support a conservative change topology: split a cleanup into independently
verifiable transformations rather than accepting a repository-wide rewrite.

[Refactoring Runaway](https://arxiv.org/abs/2605.22526), based on 3,691 agent
patches, also finds that mixing incidental refactoring into feature or bug work
is associated with lower compilability. Its refactoring-aware refinement pass
nearly doubled compilability in the evaluated subset. Refactoring should be an
explicit task with explicit necessity, not unreviewed churn smuggled into another
change.

### Agents can iterate toward a stable local result, but convergence is not proof

[From Restructuring to Stabilization](https://arxiv.org/abs/2602.21833) ran
GPT-5.1 through five readability-refactoring iterations over 230 Java snippets.
The first passes made structural changes and later passes stabilized. That
supports a short iterative cleanup loop, but only for local readability: a model
repeating itself is not evidence that it found the right domain architecture.

An adjacent warning comes from
[Do AI Agents Really Improve Code Readability?](https://arxiv.org/abs/2603.13723).
Across 403 agent-authored readability commits, maintainability index decreased
in 56.1% and cyclomatic complexity increased in 42.7%. Neither metric is a
complete definition of readability, but the result shows why “the agent says
this is cleaner” is not an acceptance criterion.

### Clean code benefits the next agent even when task success is unchanged

[Does Code Cleanliness Affect Coding Agents?](https://arxiv.org/abs/2605.20049)
uses clean/messy repository pairs with matching architecture, dependencies, and
external behavior. Across 660 Claude Code trials, cleanliness did not materially
change pass rate, but clean repositories used roughly 7–8% fewer tokens and 34%
fewer file revisits. Cleanup is therefore not just human aesthetics: it reduces
the navigational tax paid on future agent work.

### Investigation and edit completeness are central bottlenecks

[SWE Atlas](https://scale.com/blog/swe-atlas-complete) reports that refactoring
failures commonly miss call sites, leave dead code, or break edge cases. Success
correlates with file-edit recall and with front-loaded exploration. Agents in
their native coding harnesses performed 1.5–2 times more exploration, search,
and execution than the same models in a generic harness.

This supports three concrete checks after every structural edit:

- enumerate and re-search all callers and imports;
- look specifically for newly dead helpers, compatibility paths, and tests;
- exercise runtime behavior rather than treating source inspection as sufficient.

It also argues for giving the refactoring agent repository-native tools, build
commands, and narrow runtime probes instead of pasting selected files into chat.

### Static analysis is a detector and constraint, not the architect

An April 2026
[evaluation of LLM repairs for SonarQube findings](https://link.springer.com/article/10.1007/s10664-026-10858-8)
supports combining deterministic detectors with context-aware model repairs.
Static tools provide reproducible findings; agents can interpret those findings
inside the repository and implement fixes. Neither side is sufficient alone:
static rules do not decide the appropriate domain boundary, while agents can
silence a warning without improving the design.

Metrics are especially unsafe as sole objectives. A model can lower line count
by compressing code, lower duplication by creating an inappropriate abstraction,
or improve coverage by adding low-value tests. Measurements should expose
hotspots and compare before/after tradeoffs, not become a scalar score the agent
is told to maximize.

### AI-era velocity needs a matching maintenance loop

The MSR 2026 study
[Speed at the Cost of Quality](https://www.cs.cmu.edu/~ckaestne/pdf/msr26.pdf)
associates Cursor adoption in its studied open-source projects with transient
velocity gains, persistent technical debt, and a 25% complexity increase. The
authors recommend quality-triggered refactoring, test requirements that scale
with generated code, and repository rules that constrain agents.

A July 2026 causal study across 603 adopting projects reports a smaller but
still measurable increase after coding-agent adoption: about 11% in a Python
cognitive-complexity measure and 3–4% in cyclomatic complexity across languages.
It did not find reduced newcomer participation, so “AI ruins every project” is
not supported; the narrower concern about structural complexity is.
[Study](https://arxiv.org/abs/2607.01810)

GitHub's own
[continuous-refactoring experiments](https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-continuous-refactoring/)
show a promising operating shape: deterministic collection first, agentic
semantic grouping second, actionable issues third, and separate downstream
changes. GitHub reports a 79% merge rate for both its semantic-function and
large-file workflows in the projects described. This is practitioner evidence,
not a controlled comparison, but it demonstrates that continuous, scoped
cleanup can be useful without granting an agent authority to rewrite everything.

### The review burden and comprehension problem are part of the debt

The qualitative study
[“An Endless Stream of AI Slop”](https://arxiv.org/abs/2603.27249) analyzes
1,154 developer discussions. Reported failure modes include timeout-based
band-aids, type escapes, deleting behavior instead of repairing it, changing
tests to accommodate broken code, and mocking hallucinated integrations. The
paper also emphasizes reviewer burden and lack of author comprehension.

A separate study of 169 refactoring commits found that developers usually
accepted LLM suggestions without modification. When they did intervene, the
changes were often major.
[Study](https://arxiv.org/abs/2605.04835)

This makes “can the maintainer explain the resulting design and its invariants?”
a real quality gate. A functionally correct codebase that no owner can explain
has accumulated comprehension debt even if its lint score is excellent.

## A useful definition of codebase slop

“AI slop” is emotionally vivid but technically underspecified. For cleanup work,
classify findings by the kind of future cost they impose:

| Class                    | Typical symptoms                                                                                               | Better evidence                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Behavioral uncertainty   | happy-path-only tests, mocked integrations, swallowed errors, permissive fallbacks                             | public-surface tests, failure-path tests, runtime probes                            |
| Structural debt          | god files, mixed responsibilities, duplicated concepts, circular dependencies, layers with no independent role | dependency graph, change history, call-site map, complexity and duplication reports |
| Accidental compatibility | unused adapters, transitional branches, aliases that no caller needs, “just in case” configuration             | repository-wide reference search, package-consumer test, supported-version policy   |
| Epistemic debt           | stale plans, contradictory docs, names that no longer match behavior, comments explaining an abandoned design  | source-of-truth inventory, docs/code comparison, maintainer walkthrough             |
| Operational debt         | scripts that only work in one shell, hidden state, manual restart rituals, unclear ownership of processes      | clean-machine setup, restart tests, operator runbook                                |
| Security debt            | fail-open behavior, test-only bypasses reaching production, ambient credentials, mocks that hide authorization | threat model, adversarial tests, configuration matrix, independent review           |
| Agent-navigation debt    | unclear entry points, repeated conventions, missing commands, giant files repeatedly re-read                   | agent trace, file revisit count, repository guidance, module boundaries             |

This prevents a cleanup campaign from degenerating into formatting churn while
the dangerous ambiguities remain.

## Recommended workflow

### 1. Freeze and describe observable behavior

Before asking an agent to improve structure:

- start from a clean branch or worktree;
- run and record the existing fast test, type, format, and build gates;
- inventory user-visible flows, public APIs, CLI behavior, persistence, protocol
  events, security invariants, and supported deployment paths;
- add missing characterization tests around high-risk behavior before moving it;
- distinguish genuine requirements from accidental current implementation.

Tests alone are not the contract. Existing tests may encode a bug, omit an edge
case, or have been modified by the same agent that created the implementation.
For critical flows, use at least one public-surface or runtime check that does
not share the implementation's internal assumptions.

### 2. Run discovery without mutation

Use deterministic tools to produce facts:

- largest and most frequently changed files;
- dependency cycles and boundary violations;
- duplicated blocks and near-duplicate concepts;
- dead exports, dependencies, flags, scripts, and compatibility branches;
- complexity and nesting hotspots;
- tests coupled to implementation details;
- documentation with no current inbound link or conflicting status.

Then ask one or more agents to explain the system, identify root causes, and map
each finding to an actual maintenance cost. Do not let the discovery agent edit.
Its output should cite files, call paths, tests, and observed commands.

### 3. Build a refactoring backlog, not a rewrite plan

Each proposed item should state:

- the concrete problem and evidence;
- why it matters for future work;
- the desired responsibility or dependency boundary;
- behavior and public interfaces that must not change;
- affected callers and migration shape;
- the smallest verification that would disprove correctness;
- expected deletions, additions, and intentionally retained compatibility;
- whether it can be reverted independently.

Prioritize by **risk multiplied by expected future change frequency**, not by
which file offends a style metric most. A large stable fixture may be harmless;
a smaller authentication module with confused ownership may deserve immediate
attention.

### 4. Propose, select, then implement

For a nontrivial item, have the agent produce two or three approaches without
editing. Select the smallest approach that improves a real boundary. Reject
plans whose value depends mainly on new indirection, generic abstractions, or a
future use case not in scope.

Give the implementation agent a detailed task containing:

- exact target and non-goals;
- public behavior to preserve;
- intended ownership after the change;
- tests and commands it must run;
- a request to search all callers before and after editing;
- a prohibition on weakening tests, types, security checks, or errors merely to
  make validation pass.

Keep one architectural idea per commit. Mechanical renames or import movement
may accompany it, but unrelated cleanup should wait.

### 5. Validate from several directions

After each slice:

1. run the normal repository gates;
2. run focused behavior tests for the moved boundary;
3. inspect the diff and net code movement;
4. search for missed callers, stale names, dead files, and duplicate paths;
5. compare the documented dependency direction with the resulting imports;
6. exercise the real surface when mocks could conceal a mismatch;
7. ask an independent reviewer to find regressions and unnecessary complexity.

The authoring agent's self-review is useful but not independent evidence. A
fresh context, different model family, deterministic analyzer, or human owner
should challenge the patch's assumptions.

### 6. Stop when the improvement is no longer clear

Iterative refactoring can stabilize, but repeated rewriting can also replace one
arbitrary style with another. Stop a slice when:

- the stated boundary is achieved;
- behavior and security evidence pass;
- known callers use one canonical path;
- no newly dead compatibility path remains;
- the maintainer can explain the result;
- another pass would be preference rather than risk reduction.

### 7. Turn accepted cleanup into prevention

After a pattern has caused real trouble, encode the narrowest durable guard:

- a test for behavior or security;
- a type or schema constraint;
- a lint/static-analysis rule;
- a package or import-boundary check;
- a documented source of truth;
- a short repository instruction explaining the invariant;
- a periodic report that opens a scoped issue rather than an autonomous rewrite.

Do not encode every taste preference as a rule. Excess policy becomes another
form of agent-navigation debt.

## Prompt shapes that match the evidence

### Read-only discovery

```text
Inspect this repository without editing it. Map the runtime entry points,
public APIs, state ownership, security boundaries, and verification surfaces.
Identify structural debt only where you can cite concrete files, duplicated
responsibilities, dependency direction, change friction, or contradictory
sources of truth. Separate facts from judgment. Do not propose fixes yet.
```

### Proposal pass

```text
For finding X, propose three behavior-preserving refactors from smallest to
largest. For each, list the resulting ownership boundary, files and callers
affected, compatibility retained, failure modes, and tests that could disprove
correctness. Do not edit. Prefer deletion and one canonical path over adding a
generic abstraction.
```

### Implementation pass

```text
Implement the selected narrow refactor. Preserve [named behaviors and public
interfaces]. Do not add features, weaken tests, broaden fallbacks, or change
security policy. Search every caller before editing and again afterward. Run
[focused checks] and the repository gate. Report remaining compatibility code
and anything the tests do not prove.
```

### Independent review pass

```text
Review this refactor adversarially. Assume passing tests are incomplete. Look
for missed callers, behavior drift, dead paths, duplicated sources of truth,
unnecessary abstraction, test weakening, and security boundary changes. Cite
specific evidence. Do not modify the code.
```

## Proposed application to Agent Connect

Agent Connect already has unusually useful raw material for this process:

- protocol and security contracts under `contract/`;
- accepted decisions under `docs/decisions/`;
- a fast gateway and SDK test layer;
- an Omnigent integration layer with a deterministic ACP agent;
- a real Codex reference profile;
- browser E2E tests and a deployed demo;
- repository terminology and product-boundary rules in `AGENTS.md`.

A sensible first campaign would be:

1. **Inventory only.** Generate a current module/dependency map and a ranked
   list of structural, compatibility, documentation, operational, and security
   debt. Do not edit.
2. **Verify the safety net.** Map every important behavior and security invariant
   to a test or explicitly mark it manual/unproven.
3. **Choose three high-leverage slices.** Likely candidates should be discovered,
   not assumed, but examples include oversized demo modules, duplicated
   authorization/session paths, transitional naming, or obsolete plans.
4. **Refactor one slice end to end.** Plan selection, implementation, focused
   validation, independent review, and one commit.
5. **Measure the effect.** Compare size, imports, duplication, complexity,
   verification time, agent file revisits, and—most importantly—whether the next
   real change is easier.
6. **Codify only demonstrated lessons.** Add rules after a cleanup proves a
   boundary useful, not before.

The first goal should not be “reduce lines by 30%.” It should be “make the next
product change cross fewer ambiguous boundaries while preserving the proven
browser-to-agent loop.” Line reduction is welcome evidence when it follows from
that goal, not the goal itself.

## Sources and limitations

Primary and first-party sources used heavily in this synthesis:

- [CodeTaste project and benchmark](https://codetaste.logicstar.ai/), March
  2026 preprint with project site updated in July;
- [Does Code Cleanliness Affect Coding Agents?](https://arxiv.org/abs/2605.20049),
  May 2026 preprint;
- [Refactoring Runaway](https://arxiv.org/abs/2605.22526), May 2026 preprint;
- [SWE-Refactor](https://arxiv.org/abs/2602.03712), February 2026 preprint;
- [SWE-CI](https://arxiv.org/abs/2603.03823), March 2026 preprint;
- [Speed at the Cost of Quality](https://www.cs.cmu.edu/~ckaestne/pdf/msr26.pdf),
  MSR 2026;
- [An Endless Stream of AI Slop](https://arxiv.org/abs/2603.27249), March 2026
  preprint;
- [Patterns of Developer Adoption of LLM-Generated Code Refactoring Suggestions](https://arxiv.org/abs/2605.04835),
  May 2026 preprint;
- [SWE Atlas](https://scale.com/blog/swe-atlas-complete), May 2026 benchmark
  report from its operator;
- [GitHub continuous-refactoring workflows](https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-continuous-refactoring/),
  January 2026 practitioner report;
- [How OpenAI uses Codex](https://cdn.openai.com/pdf/6a2631dc-783e-479b-b1a4-af0cfbd38630/how-openai-uses-codex.pdf),
  June 2026 first-party usage guide.

Important limitations:

- Many studies use Java or Python rather than TypeScript.
- Model and harness capabilities are moving faster than peer-review cycles.
- Static metrics are imperfect proxies for maintainability and can conflict.
- Observational adoption studies cannot isolate every project-selection effect.
- Benchmark alignment with a historical human refactor is not identical to
  finding the best design for a new product.
- Independent human comprehension and real future-change cost remain difficult
  to automate or measure.

The evidence is strong enough to reject unrestricted cleanup prompts and adopt
small, specified, independently validated refactors. It is not strong enough to
delegate architectural ownership to an autonomous maintenance loop.
