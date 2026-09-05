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
omnigent_version=$(node -p 'JSON.parse(require("node:fs").readFileSync("config/omnigent-test-compat.json", "utf8")).version')
chrome_version=$(node -p 'JSON.parse(require("node:fs").readFileSync("config/webmcp-test-compat.json", "utf8")).version')
if [[ ! "$omnigent_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! "$chrome_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid provider or Chrome compatibility pin." >&2
  exit 1
fi

python3 -c 'import sys; assert sys.version_info >= (3, 12), "Omnigent requires Python 3.12+"'
tools_dir=$(mktemp -d "$RUNNER_TEMP/agent-connect-ci-tools.XXXXXX")
python3 -m venv "$tools_dir/omnigent"
# The provider version is pinned; its transitive Python dependencies remain ranged.
# These instrumentation packages only publish beta releases. Opt them in explicitly
# instead of allowing prereleases for every dependency with pip --pre.
"$tools_dir/omnigent/bin/python" -m pip --isolated install \
  --index-url https://pypi.org/simple --disable-pip-version-check \
  "omnigent==$omnigent_version" \
  "opentelemetry-instrumentation-fastapi>=0.65b0,<1" \
  "opentelemetry-instrumentation-httpx>=0.65b0,<1" \
  "opentelemetry-instrumentation-sqlalchemy>=0.65b0,<1"
actual_omnigent=$("$tools_dir/omnigent/bin/omnigent" --version)
if [[ ! "$actual_omnigent" =~ ^omnigent[[:space:]]+([^[:space:]]+) || "${BASH_REMATCH[1]}" != "$omnigent_version" ]]; then
  echo "Unexpected Omnigent version: $actual_omnigent" >&2
  exit 1
fi
printf '%s\n' "$tools_dir/omnigent/bin" >> "$GITHUB_PATH"

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
printf 'Installed %s and %s\n' "$actual_omnigent" "$actual_chrome"
