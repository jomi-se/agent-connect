#!/usr/bin/env bash
set -euo pipefail

# Ephemeral GitHub-hosted runners only; no changes to operator toolchains.
: "${RUNNER_TEMP:?GitHub Actions runner temporary directory is required}"
: "${GITHUB_PATH:?GitHub Actions PATH file is required}"
: "${GITHUB_ENV:?GitHub Actions environment file is required}"
command -v rustup >/dev/null || { echo "The runner must provide rustup." >&2; exit 1; }

rust_version=1.98.1
dist_version=0.33.0
zigbuild_version=0.23.4
zig_version=0.14.1
tools_dir=$(mktemp -d "$RUNNER_TEMP/agent-connect-build-tools.XXXXXX")
mkdir -p "$tools_dir/bin" "$tools_dir/dist"

case "$(uname -s):$(uname -m)" in
  Darwin:arm64|Darwin:aarch64)
    dist_target=aarch64-apple-darwin
    dist_sha256=7b3cbe25511de01d74c0f5fcb7909edabd379bea9cfa284d93af5a3cdfa3247c
    rust_targets=(aarch64-apple-darwin)
    ;;
  Linux:x86_64)
    dist_target=x86_64-unknown-linux-musl
    dist_sha256=b8e95bc76c63375958173ef5ae2dbd8e9211cc1ed03cdee0899702766b4c2a2e
    rust_targets=(x86_64-unknown-linux-musl aarch64-unknown-linux-musl)
    ;;
  Linux:aarch64|Linux:arm64)
    dist_target=aarch64-unknown-linux-musl
    dist_sha256=4761cff5fc547ad66d1449abbf321380b0e6bd8093b1fe6593852a3314fd0c19
    rust_targets=(x86_64-unknown-linux-musl aarch64-unknown-linux-musl)
    ;;
  *) echo "Unsupported release build runner." >&2; exit 1 ;;
esac

rustup toolchain install "$rust_version" --profile minimal --component rustfmt --component clippy
rustup target add --toolchain "$rust_version" "${rust_targets[@]}"
export RUSTUP_TOOLCHAIN="$rust_version"
printf 'RUSTUP_TOOLCHAIN=%s\n' "$rust_version" >> "$GITHUB_ENV"

archive="$tools_dir/cargo-dist.tar.xz"
curl --proto '=https' --tlsv1.2 --fail --location --retry 3 --show-error \
  "https://github.com/axodotdev/cargo-dist/releases/download/v$dist_version/cargo-dist-$dist_target.tar.xz" \
  --output "$archive"
python3 - "$archive" "$dist_sha256" <<'PY'
import hashlib, pathlib, sys
actual = hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest()
if actual != sys.argv[2]:
    raise SystemExit("Pinned cargo-dist archive checksum mismatch")
PY
tar -xJf "$archive" --strip-components=1 -C "$tools_dir/dist"
cp "$tools_dir/dist/dist" "$tools_dir/bin/dist"
chmod 755 "$tools_dir/bin/dist"
ln -s dist "$tools_dir/bin/cargo-dist"

python3 -m venv "$tools_dir/zig"
"$tools_dir/zig/bin/python" -m pip install --disable-pip-version-check "ziglang==$zig_version"
printf '#!/usr/bin/env bash\nexec "%s" -m ziglang "$@"\n' "$tools_dir/zig/bin/python" > "$tools_dir/bin/zig"
chmod 755 "$tools_dir/bin/zig"
# Native musl builds also compile C dependencies (for example rustls/ring).
# cargo-dist can use plain cargo on the host architecture; give it a pinned
# musl compiler and linker rather than relying on a host musl-gcc installation.
for target in "${rust_targets[@]}"; do
  case "$target" in
    *-unknown-linux-musl)
      compiler="$tools_dir/bin/$target-gcc"
      zig_target=${target/-unknown/}
      printf '#!/usr/bin/env bash\nargs=()\nfor arg in "$@"; do\n  case "$arg" in --target=*) ;; *) args+=("$arg");; esac\ndone\nexec "%s" cc -target "%s" "${args[@]}"\n' \
        "$tools_dir/bin/zig" "$zig_target" > "$compiler"
      chmod 755 "$compiler"
      printf 'CC_%s=%s\n' "${target//-/_}" "$compiler" >> "$GITHUB_ENV"
      linker_key=${target//-/_}
      printf 'CARGO_TARGET_%s_LINKER=rust-lld\n' "${linker_key^^}" >> "$GITHUB_ENV"
      ;;
  esac
done
cargo install --locked --version "$zigbuild_version" --root "$tools_dir/cargo-tools" cargo-zigbuild
export PATH="$tools_dir/bin:$tools_dir/cargo-tools/bin:$PATH"
printf '%s\n' "$tools_dir/bin" "$tools_dir/cargo-tools/bin" >> "$GITHUB_PATH"

printf 'CARGO_ENCODED_RUSTFLAGS=%s\n' "$(node scripts/release-build-env.mjs)" >> "$GITHUB_ENV"

[[ "$(dist --version)" == "cargo-dist $dist_version" ]]
[[ "$(cargo-zigbuild --version)" == "cargo-zigbuild $zigbuild_version" ]]
[[ "$(zig version)" == "$zig_version" ]]
printf 'Installed release build pins: Rust %s, cargo-dist %s, cargo-zigbuild %s, Zig %s\n' \
  "$rust_version" "$dist_version" "$zigbuild_version" "$zig_version"
