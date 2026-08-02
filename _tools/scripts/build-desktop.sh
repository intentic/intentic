#!/usr/bin/env bash
# Build every desktop installer on the Linux release runner — the same single-runner cross-compile pattern
# build-agent-binaries.sh uses for the machine agents:
#   • Linux bundles (deb / rpm / AppImage) natively,
#   • the Windows NSIS installer via cargo-xwin (MSVC target, no Windows runner),
#   • latest.json — the tauri-updater manifest.
#
# Runs from release-prepare.sh: build-desktop.sh <version>. Installs its own toolchain when missing
# (idempotent), so the release job needs no extra before_script.
#
# Updater signing: set TAURI_SIGNING_PRIVATE_KEY (+ optional _PASSWORD) as masked CI variables — generate a
# pair once with `pnpm --filter @intentic/desktop-app exec tauri signer generate`. The committed pubkey lives
# in tauri.conf.json. Without the variable the installers still build; the .sig files and latest.json are
# skipped, which means no auto-update for that release.
#
# The artifacts land in _apps/desktop/dist-bin/, from where the release ships them twice: attached to the
# GitHub Release (publish-github.sh — the download surface the site and the updater point at) and to this
# project's GitLab generic Package Registry (publish-agent-binaries.sh), which stays for as long as installs
# built before the GitHub cutover are still polling the endpoint baked into their binary.
set -euo pipefail

VERSION="${1:?usage: build-desktop.sh <version>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/_apps/desktop"
TAURI_DIR="$APP/src-tauri"
OUT="$APP/dist-bin"
# Where the updater fetches an installer FROM: the GitHub Release for this exact version, so a manifest always
# points at the build it describes. ONE set of URLs regardless of which endpoint served the manifest — the
# GitLab copy of latest.json carries these same GitHub links, so an install that predates the cutover and still
# polls the old endpoint downloads from the new one.
DOWNLOADS="https://github.com/radarsu/intentic/releases/download/v${VERSION}"

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

# A configured pubkey + createUpdaterArtifacts makes `tauri build` demand the private key — so when the CI
# variable is absent, updater artifacts must be switched off for the build to succeed at all.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    CONFIG="{\"version\":\"${VERSION}\"}"
else
    CONFIG="{\"version\":\"${VERSION}\",\"bundle\":{\"createUpdaterArtifacts\":false}}"
fi

# The AppImage bundler runs linuxdeploy (itself an AppImage), which FUSE-mounts by default — CI containers
# have no FUSE, so make it self-extract instead. NO_STRIP because linuxdeploy's bundled strip predates RELR
# relocations and distro libs ship pre-stripped anyway.
export APPIMAGE_EXTRACT_AND_RUN=1
export NO_STRIP=true

# Stale bundles from a previous (cached) build would make the glob-copies below ambiguous.
LINUX_BUNDLES="$TAURI_DIR/target/release/bundle"
WIN_BUNDLES="$TAURI_DIR/target/x86_64-pc-windows-msvc/release/bundle"
rm -rf "$LINUX_BUNDLES" "$WIN_BUNDLES"

echo "==> building Linux bundles (deb, rpm, appimage)"
pnpm exec tauri build --config "$CONFIG" --bundles deb,rpm,appimage

echo "==> building Windows NSIS installer (cargo-xwin)"
pnpm exec tauri build --config "$CONFIG" --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis

# --- collect with stable (un-versioned) names, so the site's vanity URLs and latest.json never need a bump ---
cp "$LINUX_BUNDLES"/appimage/*.AppImage "$OUT/Intentic.AppImage"
cp "$LINUX_BUNDLES"/deb/*.deb "$OUT/Intentic.deb"
cp "$LINUX_BUNDLES"/rpm/*.rpm "$OUT/Intentic.rpm"
cp "$WIN_BUNDLES"/nsis/*-setup.exe "$OUT/Intentic-setup.exe"

# --- updater manifest (only when the artifacts were signed) ---
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    echo "==> writing latest.json"
    appimage_sig="$(cat "$LINUX_BUNDLES"/appimage/*.AppImage.sig)"
    nsis_sig="$(cat "$WIN_BUNDLES"/nsis/*-setup.exe.sig)"
    cat >"$OUT/latest.json" <<MANIFEST
{
    "version": "${VERSION}",
    "notes": "https://github.com/radarsu/intentic/releases/tag/v${VERSION}",
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
