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

VERSION="${1:?usage: build-desktop.sh <version> [--linux-only]}"
# --linux-only skips the Windows cross-build (and the cargo-xwin toolchain it needs). For the pre-release
# verification job, which exercises the Linux bundles on a real host and has no use for an installer it cannot
# run — the release itself always builds everything. One build script either way, so the artifacts a CI job
# verifies are produced by exactly the path that produces the released ones.
LINUX_ONLY=0
if [ "${2:-}" = "--linux-only" ]; then
    LINUX_ONLY=1
fi
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
# xdg-utils is not a compiler dep but a bundle INPUT: the `intentic://` deep-link scheme in tauri.conf.json makes
# the AppImage bundler copy the host's /usr/bin/xdg-mime into the AppDir verbatim (it is what registers the scheme
# on first run), and a host without it aborts the bundle — `failed to bundle project: xdg-mime binary not found`.
# `file` is the same kind of input one level down: linuxdeploy's appimage output plugin shells into
# appimagetool, which refuses to start without it — "file command is missing but required, please install it",
# reported back through tauri as the contentless `failed to run linuxdeploy`. Absent from the CI job image
# (node:24-bookworm-slim carries no /usr/bin/file), present on most desktops, which is exactly the shape of
# dependency that only ever fails in CI.
# p7zip-full/rpm are not build inputs — they are what verify-desktop-bundle.sh (run at the end of this
# script) uses to read back the rpm and the NSIS installer it just produced. Installed here so the verification
# is unconditional: a verifier that skips when its tool is absent reports "verified" for a bundle nobody opened.
if ! command -v makensis >/dev/null 2>&1 || ! command -v xdg-mime >/dev/null 2>&1 ||
    ! command -v file >/dev/null 2>&1 ||
    ! command -v 7z >/dev/null 2>&1 || ! command -v rpm2archive >/dev/null 2>&1 ||
    ! dpkg -s libwebkit2gtk-4.1-dev >/dev/null 2>&1; then
    echo "==> installing system build deps"
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends \
        libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf \
        build-essential libssl-dev pkg-config nsis lld llvm clang xdg-utils file \
        p7zip-full rpm
fi
if ! command -v cargo >/dev/null 2>&1; then
    echo "==> installing rust"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
fi
# rustup writes its env file into CARGO_HOME when overridden (the CI jobs do, for caching).
# shellcheck disable=SC1091
source "${CARGO_HOME:-$HOME/.cargo}/env"
if [ "$LINUX_ONLY" -eq 0 ]; then
    rustup target add x86_64-pc-windows-msvc >/dev/null
    if ! command -v cargo-xwin >/dev/null 2>&1; then
        echo "==> installing cargo-xwin"
        cargo install --locked cargo-xwin
    fi
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
# Both CI jobs that run this set CARGO_TARGET_DIR to the shared /ci-cache store, and cargo puts the bundles
# under THAT — so the src-tauri/target spelling cleaned nothing and the copies below looked for artifacts in a
# directory the build never wrote to.
TARGET_DIR="${CARGO_TARGET_DIR:-$TAURI_DIR/target}"
LINUX_BUNDLES="$TARGET_DIR/release/bundle"
WIN_BUNDLES="$TARGET_DIR/x86_64-pc-windows-msvc/release/bundle"
rm -rf "$LINUX_BUNDLES" "$WIN_BUNDLES"

echo "==> building Linux bundles (deb, rpm, appimage)"
pnpm exec tauri build --config "$CONFIG" --bundles deb,rpm,appimage

if [ "$LINUX_ONLY" -eq 0 ]; then
    echo "==> building Windows NSIS installer (cargo-xwin)"
    pnpm exec tauri build --config "$CONFIG" --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
fi

# --- collect with stable (un-versioned) names, so the site's vanity URLs and latest.json never need a bump ---
cp "$LINUX_BUNDLES"/appimage/*.AppImage "$OUT/Intentic.AppImage"
cp "$LINUX_BUNDLES"/deb/*.deb "$OUT/Intentic.deb"
cp "$LINUX_BUNDLES"/rpm/*.rpm "$OUT/Intentic.rpm"
if [ "$LINUX_ONLY" -eq 0 ]; then
    cp "$WIN_BUNDLES"/nsis/*-setup.exe "$OUT/Intentic-setup.exe"
fi

# --- updater manifest (only when the artifacts were signed) ---
# Never on a --linux-only build: a manifest naming a windows-x86_64 platform whose installer this run did not
# produce would advertise an update that 404s.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ "$LINUX_ONLY" -eq 0 ]; then
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

# Verify what was just built before anything publishes it. Here rather than as a separate CI step because this
# is the only place every release artifact exists at once, and because a bundle that shipped without its
# scripts — or without the intentic:// registration — is not a thing to discover after the GitHub Release is
# cut. Seconds, no Docker, no display; see the script's header for the two regression classes.
bash "$ROOT/_tools/scripts/verify-desktop-bundle.sh" "$OUT"
