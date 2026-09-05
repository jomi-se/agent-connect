# Dependency updates and main-branch policy

Routine dependency work should be a monthly batch, not a daily inbox.

## Dependabot

- npm patch/minor updates are grouped into routine dependencies, ACP runtime
  dependencies and a separate Playwright PR. Maximum three open version PRs.
- Actions patch/minor updates form one group, maximum one open version PR.
- Version updates run monthly with a seven-day release cooldown. Major upgrades
  are deliberate maintenance work, not automatically generated version PRs.
- Security updates are enabled separately and grouped by ecosystem. The
  `allow.update-types` restriction applies to version updates only; security
  fixes are not held for the monthly schedule/cooldown or excluded for being major.
- No automatic merge. Changes to ACP, Codex adapters or browser compatibility
  still deserve explicit review even when their semver change is small.

The current backlog is not merged or discarded by this configuration change.
Review urgent security fixes first. Consolidate superseded routine updates only
after a tested maintenance change has landed; do not assume all old PRs are safe.

## PR verification

`CI / PR checks` runs on PRs to main, main pushes and manual dispatch. It checks
the exact PR head rather than relying solely on GitHub's synthetic merge commit.
The branch must contain current main and no merge commits on top of it. Use:

```sh
git fetch origin
git rebase origin/main
git push --force-with-lease origin YOUR-PR-BRANCH
```

Force-with-lease is for the PR branch, **never main**. When main advances, strict
required checks make a previously green PR out of date until it is updated.
GitHub rebase-and-merge rewrites commit IDs; this is intentionally not strict
commit-preserving fast-forward merging. Squash and merge-commit methods are disabled.

The CI runner is disposable Ubuntu 24.04 x64 with read-only repository access,
no operator credentials and no self-hosted runner. It runs:

- format, typecheck, unit tests, ACP policy, build;
- real pinned Omnigent with a deterministic ACP fixture (no model usage);
- process-crash recovery and installed npm-package consumer;
- native WebMCP using the explicit Chrome-for-Testing pin, and Canvas;
- lint and dependency-boundary checks.

Native API or provider installation failures fail the check, not skip it. Python
transitive dependencies remain ranged; compatibility pins are not a complete
reproducible build lock. Lint's existing advisory warnings remain advisory.

## Permissions and required gates

Main permits owner direct pushes and otherwise requires PRs, `PR checks` and
`gitleaks`, with a current base. On this personal repository only `jomi-se` has
the admin role used for the bypass. Re-evaluate that assumption if ownership or
roles change. An agent using the owner's credentials has the same rights.
The bypass also permits deliberate merge override; it is not a human detector.

History rules are separate and have no bypass: no force pushes, deletions or
merge commits on main. Normal PR merges use GitHub's rebase-and-merge method.
No mandatory external approval is added: requiring somebody else to approve
the owner's own PR would deadlock this single-maintainer repository.

Live activation and check evidence are recorded in
[the maintenance ledger](../plan/repository-maintenance.md). A YAML file alone
does not establish that GitHub settings were applied or that hosted CI passed.
