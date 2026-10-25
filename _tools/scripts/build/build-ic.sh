#!/usr/bin/env bash
# Cross-build explicitly requested ic targets into _sandbox/ic/dist-bin/ic-<os>-<arch>[.exe]; --version stamps release builds.
# Linux uses static musl via cargo-zigbuild; Windows uses cargo-xwin/MSVC. Missing toolchains have idempotent developer fallbacks.
# Darwin uses Zig libSystem stubs and ad-hoc signing without an SDK; the xcrun SDK warning is expected unless frameworks are added.
# Unstamped builds report the source sentinel 0.0.0. Do not publish targets the setup cards cannot support.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
cd "$(repo_root)"

# THE VERSION THE BINARY WILL REPORT. Compiled in through IC_VERSION (main.rs reads it with `option_env!`),
# because the artifact is one static binary with no package.json or Cargo.toml beside it, and because
# set-versions.sh stamps npm packages only — a Cargo.toml this script rewrote would be a second place to bump.
# Absent leaves the crate's 0.0.0 sentinel, which is what a working-tree build should say it is.
VERSION="0.0.0"
if [ "${1:-}" = "--version" ]; then
  VERSION="${2:?usage: build-ic.sh [--version <v>] <target>...}"
  shift 2
fi
export IC_VERSION="$VERSION"

[ $# -ge 1 ] || { echo "usage: build-ic.sh [--version <v>] <target>... (linux-x64 linux-arm64 windows-x64 darwin-x64 darwin-arm64)" >&2; exit 2; }

MANIFEST="_sandbox/ic/Cargo.toml"
OUT="_sandbox/ic/dist-bin"
# Where cargo actually WRITES the binaries. The release job points CARGO_TARGET_DIR at the shared /ci-cache
# store, and cargo obeys that over the crate-local target/ — so the hardcoded spelling finds nothing there and
# nothing else: `cp: cannot stat '_sandbox/ic/target/…/ic'`, passing everywhere a developer runs it. build-desktop.sh
# carries the identical line after learning it the same way.
TARGET_DIR="${CARGO_TARGET_DIR:-_sandbox/ic/target}"
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
  rustup target add "$triple" >/dev/null
  echo "==> ic for $target ($triple)"
  # Drop this crate's cached units before every build: Cargo's mtime freshness can reuse another checkout's binary.
  # Shared CARGO_TARGET_DIR and identical container checkout paths make older sources appear current against a newer runner's cache.
  # Keep dependency units cached; only rebuilding this crate is needed to prevent shipping stale ic commands.
  cargo clean --manifest-path "$MANIFEST" --release --target "$triple" -p ic
  case "$runner" in
    zigbuild) cargo zigbuild --manifest-path "$MANIFEST" --release --target "$triple" ;;
    # The C runtime linked in, not imported: a fresh Windows has no VCRUNTIME140.dll (it arrives with the Visual C++
    # Redistributable, which some other program has usually installed, and on a clean PC nothing has). Imported, the
    # binary every setup's first step runs died there with STATUS_DLL_NOT_FOUND (0xC0000135) before printing a word
    # (2026-10-08, a fresh Windows 11 26H2 VM). The desktop app was never affected: tauri-build links it statically.
    xwin) CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS="${CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS:-} -C target-feature=+crt-static" \
      cargo xwin build --manifest-path "$MANIFEST" --release --target "$triple" ;;
  esac
  src="$TARGET_DIR/${triple}/release/ic"
  [ -f "$src" ] || src="${src}.exe"
  # The clean above removed the uplifted binary as well, so whatever is here now is what this build wrote —
  # which is the property the copy needs and never had. Said out loud rather than left to `cp` to discover,
  # because the failure it replaces was silent: a leftover binary copies just as happily as a fresh one.
  [ -f "$src" ] || { echo "error: no ic binary at $src after building $target" >&2; exit 1; }
  cp "$src" "$OUT/$name"
  # SIGNED LIKE THE INSTALLER, because it is downloaded like one. Every shim fetches this binary from a
  # GitHub release and runs it, so it arrives on a user's PC carrying the mark-of-the-web and gets the same
  # SmartScreen and Defender scrutiny the .exe installer does — and it runs at the most fragile moment of the
  # whole flow, before anything else has worked. Does nothing when signing is not configured.
  case "$target" in
    windows-*) bash "$(dirname "$0")/sign-windows.sh" "$OUT/$name" ;;
  esac
done

# …and prove the stamp landed, by ASKING one of the binaries just built. An env var that silently stops
# reaching rustc — a flag renamed, an `option_env!` renamed on one side only — produces a binary that builds,
# ships, is downloaded by every connect one-liner and reports 0.0.0 forever, which is invisible everywhere
# except a user being asked which build they have. Only the runner's own os/arch can be executed here, which
# is enough: every target comes off the same source through the same variable.
native_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
native_arch="$(uname -m)"
case "$native_arch" in
  x86_64 | amd64) native_arch=amd64 ;;
  arm64 | aarch64) native_arch=arm64 ;;
esac
native="$OUT/ic-${native_os}-${native_arch}"
if [ ! -x "$native" ]; then
  echo "note: no ic-${native_os}-${native_arch} in this build — version stamp not verified on this runner." >&2
elif [ "$("$native" --version)" != "ic $VERSION" ]; then
  echo "error: ic was stamped $VERSION but reports '$("$native" --version)' — IC_VERSION did not reach the binary." >&2
  exit 1
else
  echo "ic: version stamp verified ($VERSION)"
fi

echo "==> ic binaries in $OUT:"
ls -l "$OUT"
