#!/usr/bin/env bash
# Validate ancestry, not just a synthetic GitHub merge result. No writes.
set -euo pipefail

base_ref="${1:-refs/remotes/origin/main}"
head_ref="${2:-HEAD}"
base_commit="$(git rev-parse --verify --end-of-options "${base_ref}^{commit}")"
head_commit="$(git rev-parse --verify --end-of-options "${head_ref}^{commit}")"

if ! git merge-base --is-ancestor "$base_commit" "$head_commit"; then
  echo "PR branch is behind or diverged from main. Rebase onto current main and push the updated branch." >&2
  exit 1
fi

merge_commits="$(git rev-list --min-parents=2 "$base_commit..$head_commit")"
if [[ -n "$merge_commits" ]]; then
  echo "PR contains merge commits. Rebase the branch instead of merging main into it." >&2
  exit 1
fi

echo "OK PR branch is rebased on current main with linear commits"
