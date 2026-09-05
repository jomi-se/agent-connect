#!/usr/bin/env bash
set -euo pipefail

check_script="$(cd "$(dirname "$0")" && pwd)/check-pr-rebase.sh"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/agent-connect-rebase-test.XXXXXX")"
# Keep the tiny disposable fixture for diagnosis; never touch the working repo.
git -C "$fixture" init -q -b main
git -C "$fixture" config user.name "Rebase policy fixture"
git -C "$fixture" config user.email "fixture@example.invalid"
git -C "$fixture" -c commit.gpgsign=false commit -q --allow-empty -m base
git -C "$fixture" switch -q -c topic
git -C "$fixture" -c commit.gpgsign=false commit -q --allow-empty -m topic
(cd "$fixture" && bash "$check_script" main topic)
git -C "$fixture" switch -q main
git -C "$fixture" -c commit.gpgsign=false commit -q --allow-empty -m advance
if (cd "$fixture" && bash "$check_script" main topic) >/dev/null 2>&1; then
  echo "FAIL: stale PR was accepted" >&2; exit 1
fi
git -C "$fixture" switch -q topic
git -C "$fixture" -c commit.gpgsign=false merge -q --no-ff main -m merge
if (cd "$fixture" && bash "$check_script" main topic) >/dev/null 2>&1; then
  echo "FAIL: merge-commit PR was accepted" >&2; exit 1
fi
git -C "$fixture" switch -q -c rebased main
git -C "$fixture" -c commit.gpgsign=false commit -q --allow-empty -m rebased
(cd "$fixture" && bash "$check_script" main rebased)
if (
  cd "$fixture"
  git() {
    if [[ "$1" == rev-list ]]; then return 128; fi
    command git "$@"
  }
  export -f git
  bash "$check_script" main rebased
) >/dev/null 2>&1; then
  echo "FAIL: git inspection failure was accepted" >&2; exit 1
fi
echo "OK rebased accepted; stale and merged branches rejected (fixture $fixture)"
