#!/usr/bin/env bash
# Build every desktop release artifact on the Linux release runner — the same single-runner
# cross-compile pattern as _apps/sync/scripts/build-binaries.sh:
#   • Linux bundles (deb / rpm / AppImage) natively,
#   • the Windows NSIS installer via cargo-xwin (MSVC target, no Windows runner),
#   • the WSL machine rootfs (docker export of scripts/machine-rootfs),
#   • latest.json — the tauri-updater manifest served from the release's /desktop/ assets.
#
# Runs in semantic-release prepareCmd: release-build.sh <version>. Installs its own toolchain when
# missing (idempotent), so the release job needs no extra before_script beyond docker-cli (already
# there for publish-images).
#
# Updater signing: set TAURI_SIGNING_PRIVATE_KEY (+ optional _PASSWORD) as masked CI variables —
# generate a pair once with `pnpm --filter @intentic-app/desktop exec tauri signer generate`. The
# committed pubkey lives in tauri.conf.json. Without the variable the installers still build; the
# .sig files and latest.json are skipped (no auto-updates for that release).
set -euo pipefail

VERSION="${1:?usage: release-build.sh <version>}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APP="$ROOT/_apps/desktop"
TAURI_DIR="$APP/src-tauri"
OUT="$APP/dist-release"
DOWNLOADS="https://gitlab.com/radarsu/intentic/-/releases/v${VERSION}/downloads/desktop"

echo "==> desktop release build v${VERSION}"

# --- toolchain (idempotent; the release job's node:24 bookworm container runs as root) ---
if ! command -v makensis >/dev/null 2>&1 || ! dpkg -s libwebkit2gtk-4.1-dev >/dev/null 2>&1; then
    echo "==> installing system build deps"
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends \
        libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf \
        build-essential libssl-dev pkg-config nsis lld llvm clang
fi
if ! command -v cargo >/dev/null 2>&1; then
    echo "==> installing rust"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
fi
# rustup writes its env file into CARGO_HOME when overridden (the CI jobs do, for caching).
# shellcheck disable=SC1091
source "${CARGO_HOME:-$HOME/.cargo}/env"
rustup target add x86_64-pc-windows-msvc >/dev/null
if ! command -v cargo-xwin >/dev/null 2>&1; then
    echo "==> installing cargo-xwin"
    cargo install --locked cargo-xwin
fi

rm -rf "$OUT"
mkdir -p "$OUT"
cd "$APP"

# A configured pubkey + createUpdaterArtifacts makes `tauri build` demand the private key — so when
# the CI variable is absent, updater artifacts must be switched off for the build to succeed at all.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    CONFIG="{\"version\":\"${VERSION}\"}"
else
    CONFIG="{\"version\":\"${VERSION}\",\"bundle\":{\"createUpdaterArtifacts\":false}}"
fi

# Stale bundles from a previous (cached) build would make the glob-copies below ambiguous.
LINUX_BUNDLES="$TAURI_DIR/target/release/bundle"
WIN_BUNDLES="$TAURI_DIR/target/x86_64-pc-windows-msvc/release/bundle"
rm -rf "$LINUX_BUNDLES" "$WIN_BUNDLES"

echo "==> building Linux bundles (deb, rpm, appimage)"
pnpm exec tauri build --config "$CONFIG" --bundles deb,rpm,appimage

echo "==> building Windows NSIS installer (cargo-xwin)"
pnpm exec tauri build --config "$CONFIG" --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis

# --- collect with stable (un-versioned) names so vanity URLs and latest.json never drift ---
cp "$LINUX_BUNDLES"/appimage/*.AppImage "$OUT/Intentic.AppImage"
cp "$LINUX_BUNDLES"/deb/*.deb "$OUT/Intentic.deb"
cp "$LINUX_BUNDLES"/rpm/*.rpm "$OUT/Intentic.rpm"
cp "$WIN_BUNDLES"/nsis/*-setup.exe "$OUT/Intentic-setup.exe"

echo "==> building the WSL machine rootfs"
docker build -t intentic-machine-rootfs "$APP/scripts/machine-rootfs"
container="$(docker create intentic-machine-rootfs)"
docker export "$container" | gzip >"$OUT/intentic-machine-amd64.tar.gz"
docker rm "$container" >/dev/null

# --- updater manifest (only when the artifacts were signed) ---
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    echo "==> writing latest.json"
    appimage_sig="$(cat "$LINUX_BUNDLES"/appimage/*.AppImage.sig)"
    nsis_sig="$(cat "$WIN_BUNDLES"/nsis/*-setup.exe.sig)"
    cat >"$OUT/latest.json" <<MANIFEST
{
    "version": "${VERSION}",
    "notes": "https://gitlab.com/radarsu/intentic/-/releases/v${VERSION}",
    "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "platforms": {
        "linux-x86_64": { "signature": "${appimage_sig}", "url": "${DOWNLOADS}/Intentic.AppImage" },
        "windows-x86_64": { "signature": "${nsis_sig}", "url": "${DOWNLOADS}/Intentic-setup.exe" }
    }
}
MANIFEST
else
    echo "==> TAURI_SIGNING_PRIVATE_KEY not set — skipping signatures + latest.json (no auto-update for this release)"
fi

(cd "$OUT" && sha256sum ./*) >"$OUT/SHA256SUMS"
echo "==> desktop artifacts:"
ls -lh "$OUT"
