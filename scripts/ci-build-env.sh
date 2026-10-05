#!/usr/bin/env bash
set -euo pipefail

# GitHub Actions only, after mise has installed the tools in mise.toml.
# rust-toolchain.toml selects Rust; this exports the release build environment.
: "${RUNNER_TEMP:?GitHub Actions runner temporary directory is required}"
: "${GITHUB_ENV:?GitHub Actions environment file is required}"
command -v zig >/dev/null || { echo "Run mise install first." >&2; exit 1; }

# Native musl builds also compile C dependencies (for example rustls/ring).
# cargo-dist uses plain cargo on the host architecture; give it Zig as the musl
# compiler and Rust's bundled LLD as the linker instead of a host musl-gcc.
if [[ "$(uname -s)" == Linux ]]; then
  compilers=$(mktemp -d "$RUNNER_TEMP/agent-connect-compilers.XXXXXX")
  for target in x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
    compiler="$compilers/$target-gcc"
    printf '#!/usr/bin/env bash\nargs=()\nfor arg in "$@"; do\n  case "$arg" in --target=*) ;; *) args+=("$arg");; esac\ndone\nexec zig cc -target "%s" "${args[@]}"\n' \
      "${target/-unknown/}" > "$compiler"
    chmod 755 "$compiler"
    key=${target//-/_}
    printf 'CC_%s=%s\n' "$key" "$compiler" >> "$GITHUB_ENV"
    printf 'CARGO_TARGET_%s_LINKER=rust-lld\n' "${key^^}" >> "$GITHUB_ENV"
  done
fi

printf 'CARGO_ENCODED_RUSTFLAGS=%s\n' "$(node scripts/release-build-env.mjs)" >> "$GITHUB_ENV"
