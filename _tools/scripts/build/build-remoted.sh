#!/usr/bin/env bash
# Cross-build intentic-remoted (_devices/remoted, Rust): the daemon that serves people's terminals (and, from phase 2,
# screens) on one of the owner's computers, downloaded beside intentic-machine by the agent the first time a sandbox
# turns remote access on, and checked against the release's signed SHA256SUMS like the launcher and the keyring.
#
#   bash _tools/scripts/build/build-remoted.sh [--version <v>] linux-x64 linux-arm64 windows-x64
#
# The targets are the platforms the machine agent ships for that remoted serves: Windows (ConPTY) and Linux (openpty).
# macOS is left out until remoted has a screen there to serve. Windows is MSVC through cargo-xwin with the C runtime
# linked in. Linux is glibc 2.28 and later (Debian 10, Ubuntu 18.10, RHEL 8) through cargo-zigbuild, linking only libc:
# a static musl binary cannot dlopen, and remoted opens the GPU's and the desktop's libraries at run time (NVENC's
# libcuda, VA-API's libva, PipeWire's libpipewire) so the one binary runs with or without them. The machine agent that
# downloads it is a glibc program already (bun's linux target), so no musl-only system loses a remoted it could run.
#
# Artifacts land in _devices/remoted/dist-bin/ as intentic-remoted-<os>-<arch>[.exe], from where publish-github.sh
# attaches them to the GitHub Release.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
cd "$(repo_root)"

# THE VERSION THE BINARY REPORTS (`intentic-remoted version`), compiled in through INTENTIC_REMOTED_VERSION: the agent
# replaces a remoted whose version is not its own, so an unstamped release binary would be downloaded again forever.
VERSION="0.0.0"
if [ "${1:-}" = "--version" ]; then
  VERSION="${2:?usage: build-remoted.sh [--version <v>] <target>...}"
  shift 2
fi
export INTENTIC_REMOTED_VERSION="$VERSION"

[ $# -ge 1 ] || { echo "usage: build-remoted.sh [--version <v>] <target>... (linux-x64 linux-arm64 windows-x64)" >&2; exit 2; }

MANIFEST="_devices/remoted/Cargo.toml"
OUT="_devices/remoted/dist-bin"
# Where cargo writes, which a shared CARGO_TARGET_DIR (the release job's /ci-cache) decides over the crate's target/.
TARGET_DIR="${CARGO_TARGET_DIR:-_devices/remoted/target}"
mkdir -p "$OUT"

command -v cargo >/dev/null 2>&1 || { echo "error: cargo (rustup) is required — https://rustup.rs" >&2; exit 1; }
need_zigbuild=0
need_xwin=0
for target in "$@"; do
  case "$target" in
    linux-*) need_zigbuild=1 ;;
    windows-*) need_xwin=1 ;;
  esac
done
if [ "$need_zigbuild" = 1 ] && ! command -v cargo-zigbuild >/dev/null 2>&1; then
  echo "==> installing cargo-zigbuild"
  cargo install --locked cargo-zigbuild
fi
if [ "$need_zigbuild" = 1 ] && ! command -v zig >/dev/null 2>&1 && ! python3 -c 'import ziglang' 2>/dev/null; then
  echo "==> installing zig (via pip ziglang)"
  zig_req="$(dirname "$0")/ziglang-requirements.txt"
  pip3 install --quiet --require-hashes -r "$zig_req" || pip3 install --quiet --break-system-packages --require-hashes -r "$zig_req" || {
    echo "error: zig is required for the linux cross-builds — install zig (or 'pip3 install --require-hashes -r _tools/scripts/build/ziglang-requirements.txt') and re-run." >&2
    exit 1
  }
fi
if [ "$need_xwin" = 1 ] && ! command -v cargo-xwin >/dev/null 2>&1; then
  echo "==> installing cargo-xwin"
  cargo install --locked cargo-xwin
fi

for target in "$@"; do
  case "$target" in
    # zigbuild reads the glibc to link against from the triple's suffix and builds into the plain triple's directory.
    linux-x64) triple="x86_64-unknown-linux-gnu" glibc=".2.28" name="intentic-remoted-linux-amd64" runner="zigbuild" ;;
    linux-arm64) triple="aarch64-unknown-linux-gnu" glibc=".2.28" name="intentic-remoted-linux-arm64" runner="zigbuild" ;;
    windows-x64) triple="x86_64-pc-windows-msvc" glibc="" name="intentic-remoted-windows-amd64.exe" runner="xwin" ;;
    *) echo "error: unknown target '$target' (remoted ships for linux-x64, linux-arm64 and windows-x64)" >&2; exit 2 ;;
  esac
  rustup target add "$triple" >/dev/null
  echo "==> intentic-remoted for $target ($triple)"
  # This crate's units dropped first, for build-ic.sh's reason: cargo's mtime freshness against a target dir several
  # checkouts share can call a stale unit current, and this is a binary people's PCs download and run.
  cargo clean --manifest-path "$MANIFEST" --release --target "$triple" -p intentic-remoted
  case "$runner" in
    # The one thing pkg-config is asked for (nvenc's ffnvcodec) is headers alone, the same for every architecture and
    # linked into nothing, so the build host's copy is the right one even where the target is a cross one (arm64).
    zigbuild) PKG_CONFIG_ALLOW_CROSS=1 cargo zigbuild --manifest-path "$MANIFEST" --release --target "${triple}${glibc}" ;;
    # The C runtime linked in, not imported: a fresh Windows has no VCRUNTIME140.dll (build-ic.sh, 2026-10-08).
    xwin) CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS="${CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS:-} -C target-feature=+crt-static" \
      cargo xwin build --manifest-path "$MANIFEST" --release --target "$triple" ;;
  esac
  src="$TARGET_DIR/${triple}/release/intentic-remoted"
  [ -f "$src" ] || src="${src}.exe"
  [ -f "$src" ] || { echo "error: no intentic-remoted binary at $src after building $target" >&2; exit 1; }
  cp "$src" "$OUT/$name"
  case "$target" in
    windows-*) bash "$(dirname "$0")/sign-windows.sh" "$OUT/$name" ;;
  esac
done

# …and prove the stamp landed by asking the binary this runner can execute: an env var that stops reaching rustc builds
# a remoted that reports 0.0.0, which the agent would replace on every start.
native_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
native_arch="$(uname -m)"
case "$native_arch" in
  x86_64 | amd64) native_arch=amd64 ;;
  arm64 | aarch64) native_arch=arm64 ;;
esac
native="$OUT/intentic-remoted-${native_os}-${native_arch}"
if [ ! -x "$native" ]; then
  echo "note: no intentic-remoted-${native_os}-${native_arch} in this build — version stamp not verified on this runner." >&2
elif [ "$("$native" version)" != "$VERSION" ]; then
  echo "error: intentic-remoted was stamped $VERSION but reports '$("$native" version)' — INTENTIC_REMOTED_VERSION did not reach the binary." >&2
  exit 1
else
  echo "intentic-remoted: version stamp verified ($VERSION)"
fi

echo "==> intentic-remoted binaries in $OUT:"
ls -l "$OUT"
