# Low-noise dependency maintenance and PR gates

Status: setup activated, 2026-09-05; dependency follow-up in progress.
Setup PR #17 merged after hosted CI run 33951196619 passed all gates.
Active rulesets: main-pr-gates 22323851, main-history 22323852.
Rebase-only repository settings and security updates enabled and read back.
Authenticated owner jomi-se is the sole admin/bypass actor.

## Accepted scope

User requested low-maintenance Dependabot, formatting/typechecks/tests on PRs,
owner-only direct pushes to main, up-to-date PRs and linear merges. They clarified
that GitHub rebase-and-merge (rewritten commit IDs) is acceptable, not strict
commit-preserving fast-forward. No dependency upgrades or existing PR merges are
authorized by the initial setup task. Follow-up authorization: resolve the
dependency backlog after setup, fix the publishing typecheck failure, and bump
the SDK patch before pushing SDK changes.

Monthly grouped nonmajor npm updates: routine group, separately reviewed ACP
group, separate Playwright update; monthly grouped nonmajor Actions. Seven-day
version cooldown, security updates outside that cadence and without a semver
major exclusion. Use allow.update-types (version-only), not a blanket ignore.
Keep exact provider/browser compatibility pins. No auto-merge.

One credential-free Ubuntu 24.04 PR verification job runs existing full checks
plus lint/dependency boundaries. Install real pinned Omnigent from PyPI in a
temporary Python 3.12+ venv, default Playwright Chromium and separately pinned
Chrome-for-Testing 153 for native WebMCP. Never skip unsupported native API.
Assert installed versions. Python transitive dependencies remain ranged: this
is version-pinned validation, not a fully reproducible Python dependency lock.
Read-only workflow token, no secrets or self-hosted runner, no pull_request_target.
PR branch must contain current main and no merge commits on top of it; verify
head itself. Strict GitHub checks also prevent merging after main advances.

Repository configuration: disable merge commits/squash, enable rebase merge;
require named CI and secret checks, up-to-date main and PRs. Preserve owner direct
push via owner/admin bypass where the personal-repository API supports it.
Keep no-force-push/deletion/linear-history rules separate and without bypass.
Inspect existing rules first and do not overwrite unrelated policy. Owner bypass
also permits explicit merge override; do not claim it distinguishes a human from
an agent using the same owner's credentials. Check authenticated owner/admin role.

## Contract

VAL-MAINT-001 — configuration surface. Monthly bounded grouped version PRs with
separate compatibility-sensitive updates; security updates remain enabled and
not delayed by version cooldown. Evidence: config/schema validation plus live
GitHub settings readback; no claims that existing PRs automatically consolidate.

VAL-MAINT-002 — PR/CI surface. All existing verify:full checks plus lint and
dependency-boundary checks run without operator credentials; fail closed on
tool install/check failure. Evidence: static workflow validation, current local
regression evidence plus real GitHub-hosted run before marking CI proven.
Base ancestry/merge-commit checks exercised on disposable git fixtures.

VAL-MAINT-003 — repository settings surface. Rebase only, checks required against
current main, only owner can bypass PR requirement; no force-push or deletion.
Evidence: live permissions/ruleset/merge-setting API readback and a PR/check run.
Do not activate a nonexistent check gate before the workflow is available.

## Handoff

Follow-up batch: fast-uri/PostCSS security patches; the pending nonmajor font,
Prettier, Vitest, Playwright, ACP SDK and codex-acp updates. SDK becomes 0.0.3
before push. A fresh npm audit also found brace-expansion; include its compatible
security patch. Keep TypeScript 6, Vite 7, Node 24 types and Actions v6: the pending
major migrations have no demonstrated need and are deliberately deferred.
Validate the batch through hosted full CI and a publish dry run, then close
superseded PRs and explain deferred majors. Do not publish to npm automatically.

Hosted bootstrap findings: pip needs explicit prerelease opt-in for Omnigent's
beta-only OpenTelemetry FastAPI instrumentation dependency. The previous publish
run also revealed a clean-checkout ordering bug: Canvas imports SDK declarations
from dist, so root typecheck must build the SDK first (pretypecheck).

Investigation confirms Python package omnigent0.5.1 and Linux x64-compatible
deterministic fixtures. Official CFT manifest lists linux64 153.0.8010.12.
GitHub owner/admin authentication is verified. Runtime plan tools are unavailable;
use this persistent ledger and
bounded independent review. Do not claim remote setup from local YAML alone.
