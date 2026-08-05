#!/usr/bin/env bash
# Cross-compile the `ic` host-side CLI (_sandbox/ic, Rust) into standalone binaries — the release assets the
# bootstrap shims download (connect.sh/connect.ps1, recreate.sh/recreate.ps1, connect-host.sh). Same
# single-runner pattern as build-agent-binaries.sh / build-desktop.sh, same explicit-target rule: shipping a
# binary for a platform no card can hand a command for implies support that does not exist.
#
#   bash _tools/scripts/build-ic.sh linux-x64 linux-arm64 windows-x64 darwin-x64 darwin-arm64
#
# Toolchains, per target family (in CI these are baked into the job image, like build-desktop.sh's; the
# fallback installs below are for developer machines and are idempotent):
#   linux-*    cargo-zigbuild → musl, STATIC: the connect one-liner runs on whatever distro the user has,
#              and a glibc-linked binary from a current rustc does not run on an older server.
#   windows-*  cargo-xwin → MSVC, the same cross toolchain the desktop release already uses.
#   darwin-*   cargo-zigbuild + the macOS SDK. The SDK cannot be auto-fetched (Apple's license), so these
#              targets REQUIRE $SDKROOT pointing at a MacOSX*.sdk — bake it into the release image alongside
#              the xwin cache. A darwin target without SDKROOT fails loudly here, at prepare time, before
#              anything tags or publishes: macOS users' connect flow depends on these assets existing.
#
# Artifacts land in _sandbox/ic/dist-bin/ as ic-<os>-<arch>[.exe] (go-style arch, matching what the shims
# request), from where publish-github.sh attaches them to the GitHub Release.
set -euo pipefail
cd "$(dirname "$0")/../.."

[ $# -ge 1 ] || { echo "usage: build-ic.sh <target>... (linux-x64 linux-arm64 windows-x64 darwin-x64 darwin-arm64)" >&2; exit 2; }

MANIFEST="_sandbox/ic/Cargo.toml"
OUT="_sandbox/ic/dist-bin"
mkdir -p "$OUT"

# --- toolchain fallback (idempotent; CI images bake all of this) ---
command -v cargo >/dev/null 2>&1 || { echo "error: cargo (rustup) is required — https://rustup.rs" >&2; exit 1; }
need_zigbuild=0
need_xwin=0
for target in "$@"; do
  case "$target" in
    linux-* | darwin-*) need_zigbuild=1 ;;
    windows-*) need_xwin=1 ;;
  esac
done
if [ "$need_zigbuild" = 1 ] && ! command -v cargo-zigbuild >/dev/null 2>&1; then
  echo "==> installing cargo-zigbuild"
  cargo install --locked cargo-zigbuild
fi
if [ "$need_zigbuild" = 1 ] && ! command -v zig >/dev/null 2>&1 && ! python3 -c 'import ziglang' 2>/dev/null; then
  echo "==> installing zig (via pip ziglang)"
  pip3 install --quiet ziglang || pip3 install --quiet --break-system-packages ziglang || {
    echo "error: zig is required for the linux/darwin cross-builds — install zig (or 'pip3 install ziglang') and re-run." >&2
    exit 1
  }
fi
if [ "$need_xwin" = 1 ] && ! command -v cargo-xwin >/dev/null 2>&1; then
  echo "==> installing cargo-xwin"
  cargo install --locked cargo-xwin
fi

for target in "$@"; do
  case "$target" in
    linux-x64) triple="x86_64-unknown-linux-musl" name="ic-linux-amd64" runner="zigbuild" ;;
    linux-arm64) triple="aarch64-unknown-linux-musl" name="ic-linux-arm64" runner="zigbuild" ;;
    darwin-x64) triple="x86_64-apple-darwin" name="ic-darwin-amd64" runner="zigbuild" ;;
    darwin-arm64) triple="aarch64-apple-darwin" name="ic-darwin-arm64" runner="zigbuild" ;;
    windows-x64) triple="x86_64-pc-windows-msvc" name="ic-windows-amd64.exe" runner="xwin" ;;
    *) echo "error: unknown target '$target'" >&2; exit 2 ;;
  esac
  case "$target" in
    darwin-*)
      if [ -z "${SDKROOT:-}" ]; then
        echo "error: $target needs the macOS SDK — set SDKROOT to a MacOSX*.sdk path (see this script's header)." >&2
        exit 1
      fi
      ;;
  esac
  rustup target add "$triple" >/dev/null
  echo "==> ic for $target ($triple)"
  case "$runner" in
    zigbuild) cargo zigbuild --manifest-path "$MANIFEST" --release --target "$triple" ;;
    xwin) cargo xwin build --manifest-path "$MANIFEST" --release --target "$triple" ;;
  esac
  src="_sandbox/ic/target/${triple}/release/ic"
  [ -f "$src" ] || src="${src}.exe"
  cp "$src" "$OUT/$name"
done

echo "==> ic binaries in $OUT:"
ls -l "$OUT"
