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

`CI / Required checks` runs on PRs to main, main pushes and manual dispatch. It checks
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

- format, typecheck, unit tests and build;
- real pinned ACP adapters with deterministic inference (no model usage);
- installed npm-package consumer and AI SDK/provider composition;
- native WebMCP using the explicit Chrome-for-Testing pin, and Canvas;
- lint and dependency-boundary checks.

Native browser or adapter installation failures fail the check. Lint warnings
remain advisory; dependency-boundary violations are hard failures.

These run as parallel jobs: static checks (format, typecheck, docs, unit tests,
lint, dependency boundaries, version and pin checks), Rust, the web SDK with
WebMCP, and the gateway (release build, box-backed scenarios, clean room).
`Required checks` passes when every job passed or was reused.

The static checks always run. Rust, web and gateway each hash what they depend
on with `scripts/ci-inputs.mjs`: every tracked file except those a job lists as
irrelevant (docs and changelogs for all three), so a file nobody listed makes
the job run. Our own package versions are normalized out of manifests and
lockfiles, so a release bump reuses the results of the commit it bumps. When a
green run already verified the same hash, the job is skipped as reused; a green
job records its hash as an empty cache entry. A manual run with `full` and the
weekly scheduled run reuse nothing, which catches drift outside the repository
(runner image, upstream tools). Bump `SCHEMA` in `scripts/ci-inputs.mjs` to
discard every recorded result.

## Permissions and required gates

CI has read-only repository permissions and does not publish. The operator owns
branch protection, required checks and permitted merge methods. Keep the branch
current with main and resolve failed checks before requesting a merge. Agents
commit reviewed changes locally; the operator pushes them.

The source files describe the intended checks. Hosted CI results and account
settings must be verified separately by the operator; local success does not
establish that remote protections are active.
