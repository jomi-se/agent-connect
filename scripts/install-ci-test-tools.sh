#!/usr/bin/env bash
set -euo pipefail

# These gates exercise Linux process cleanup and Chrome's native x64 binding.
if [[ "$(uname -s):$(uname -m)" != "Linux:x86_64" ]]; then
  echo "CI test tools require Linux x64; unsupported platforms must not skip native coverage." >&2
  exit 1
fi

: "${RUNNER_TEMP:?Run this installer in a GitHub-hosted runner}"
: "${GITHUB_PATH:?GitHub Actions PATH file is required}"
: "${GITHUB_ENV:?GitHub Actions environment file is required}"

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"
chrome_version=$(node -p 'JSON.parse(require("node:fs").readFileSync("config/webmcp-test-compat.json", "utf8")).version')
if [[ ! "$chrome_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid Chrome compatibility pin." >&2
  exit 1
fi

tools_dir=$(mktemp -d "$RUNNER_TEMP/agent-connect-ci-tools.XXXXXX")
node scripts/openclaw-install.mjs "$tools_dir/openclaw"
printf '%s\n' "$tools_dir/openclaw/node_modules/.bin" >> "$GITHUB_PATH"
printf 'OPENCLAW_TEST_BIN=%s\n' "$tools_dir/openclaw/node_modules/.bin/openclaw" >> "$GITHUB_ENV"

# Canvas uses Playwright's bundled browser; WebMCP needs the separate native pin.
npx playwright install --with-deps chromium
chrome_archive="$tools_dir/chrome.zip"
curl --fail --location --retry 3 --show-error \
  "https://storage.googleapis.com/chrome-for-testing-public/$chrome_version/linux64/chrome-linux64.zip" \
  --output "$chrome_archive"
unzip -q "$chrome_archive" -d "$tools_dir"
chrome_executable="$tools_dir/chrome-linux64/chrome"
actual_chrome=$("$chrome_executable" --version)
if [[ ! "$actual_chrome" =~ ^Google[[:space:]]Chrome[[:space:]]for[[:space:]]Testing[[:space:]]([^[:space:]]+) || "${BASH_REMATCH[1]}" != "$chrome_version" ]]; then
  echo "Unexpected Chrome version: $actual_chrome" >&2
  exit 1
fi
printf 'WEBMCP_CHROMIUM_EXECUTABLE=%s\n' "$chrome_executable" >> "$GITHUB_ENV"
printf 'Installed pinned OpenClaw and %s\n' "$actual_chrome"
