#!/bin/sh
set -eu

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

existing_hooks_path=$(git config --local --get core.hooksPath || true)
if test -n "$existing_hooks_path" && test "$existing_hooks_path" != ".githooks"; then
  echo "Refusing to replace existing core.hooksPath: $existing_hooks_path" >&2
  exit 1
fi

./scripts/install-gitleaks.sh
git config --local core.hooksPath .githooks

echo "Installed Agent Connect hooks for this checkout."
