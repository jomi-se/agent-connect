#!/usr/bin/env bash

set -u

if [[ ! -d .git ]]; then
  echo "Run this script from the repository root." >&2
  exit 2
fi

secret=""
cleanup() {
  unset secret
}
trap cleanup EXIT INT TERM

read -r -s -p "Secret to search for (input hidden): " secret
printf '\n'

if [[ -z "$secret" ]]; then
  echo "Refusing to search for an empty value." >&2
  exit 2
fi

found=0
while IFS= read -r commit; do
  if printf '%s\n' "$secret" | git grep -q -F -f - "$commit" -- .; then
    printf '%s\n' "$secret" | git grep -l -F -f - "$commit" -- .
    found=1
  fi
done < <(git rev-list --all --reflog)

if (( found )); then
  echo "Secret found in Git history. Rotate it before publishing the repository." >&2
  exit 1
fi

echo "Secret not found in reachable Git history or reflogs."
