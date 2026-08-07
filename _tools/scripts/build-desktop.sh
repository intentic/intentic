#!/usr/bin/env bash
# Build every desktop installer on the Linux release runner — the same single-runner cross-compile pattern
# build-agent-binaries.sh uses for the machine agents:
#   • Linux bundles (deb / rpm / AppImage) natively,
#   • the Windows NSIS installer via cargo-xwin (MSVC target, no Windows runner),
#   • latest.json — the tauri-updater manifest.
#
# Runs from release-prepare.sh: build-desktop.sh <version> --windows-prebuilt <dir>. Installs its own toolchain
# when missing (idempotent), so the release job needs no extra before_script.
#
# Updater signing: set TAURI_SIGNING_PRIVATE_KEY (+ optional _PASSWORD) as masked CI variables — generate a
# pair once with `pnpm --filter @intentic/desktop-app exec tauri signer generate`. The committed pubkey lives
# in tauri.conf.json. Without the variable the installers still build; the .sig files and latest.json are
# skipped, which means no auto-update for that release.
#
# The artifacts land in _editor/desktop-app/dist-bin/, from where publish-github.sh attaches them to the GitHub
# Release — the download surface the site and the updater both point at.
set -euo pipefail

VERSION="${1:?usage: build-desktop.sh <version> [--linux-only|--windows-only|--windows-prebuilt <dir>]}"
# Two verification jobs each want ONE side of this build, and the release wants both. One build script either
# way, so the artifacts a CI job verifies are produced by exactly the path that produces the released ones.
#
#   --linux-only    skips the Windows cross-build and the cargo-xwin toolchain it needs. For desktop-verify,
#                   which exercises the Linux bundles on a real host and has no use for an installer it cannot
#                   run.
#   --windows-only  skips the Linux bundles. For the job that hands `Intentic-setup.exe` to the Windows runner:
#                   a deb/rpm/AppImage build costs it several minutes of artifacts nothing downstream opens.
#   --windows-prebuilt <dir>
#                   builds Linux and stages the already-tested NSIS candidate from this directory. The release
#                   uses it so Windows approves the bytes publish-github.sh actually attaches.
#
# Neither writes latest.json — a manifest naming a platform whose installer the run did not produce would
# advertise an update that 404s, and that is true in both directions.
LINUX_ONLY=0
WINDOWS_ONLY=0
WINDOWS_PREBUILT=""
case "${2:-}" in
    --linux-only) LINUX_ONLY=1 ;;
    --windows-only) WINDOWS_ONLY=1 ;;
    --windows-prebuilt)
        WINDOWS_PREBUILT="${3:?usage: build-desktop.sh <version> --windows-prebuilt <dir>}"
        ;;
    "") ;;
    *)
        echo "error: unknown flag '${2}' (expected --linux-only, --windows-only, or --windows-prebuilt <dir>)" >&2
        exit 2
        ;;
esac
if [ -n "$WINDOWS_PREBUILT" ] && [ ! -f "$WINDOWS_PREBUILT/Intentic-setup.exe" ]; then
    echo "error: the tested Windows installer is missing from $WINDOWS_PREBUILT" >&2
    exit 2
fi
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/_editor/desktop-app"
TAURI_DIR="$APP/src-tauri"
OUT="$APP/dist-bin"
# Where the updater fetches an installer FROM: the GitHub Release for this exact version, so a manifest always
# points at the build it describes.
DOWNLOADS="https://github.com/intentic/intentic/releases/download/v${VERSION}"

echo "==> desktop release build v${VERSION}"

# --- toolchain: the FALLBACK path (idempotent; runs as root) ---
# In CI none of this executes — _tools/ci-desktop bakes every tool below into the image the desktop jobs run in,
# because installing them per job cost 2m53s (apt) + 41s (rustup) in release job 15686372011 and repeated in
# desktop-check and desktop-verify. What is left here is what a developer machine needs, and it is what keeps
# `build-desktop.sh <version>` a command anyone can run.
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
# Make an already-installed toolchain visible BEFORE deciding to install one. This probe used to run first and
# the env file was sourced after it, so it could never see the cargo that rustup had put in $CARGO_HOME/bin —
# whose bin/ is not on a fresh job's PATH — and every run re-downloaded a toolchain it already had (41s, "info:
# downloading 3 components", release job 15686372011).
if [ -f "${CARGO_HOME:-$HOME/.cargo}/env" ]; then
    # shellcheck disable=SC1091
    source "${CARGO_HOME:-$HOME/.cargo}/env"
fi
if ! command -v cargo >/dev/null 2>&1; then
    echo "==> installing rust"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
    # shellcheck disable=SC1091
    source "${CARGO_HOME:-$HOME/.cargo}/env"
fi
if [ "$LINUX_ONLY" -eq 0 ] && [ -z "$WINDOWS_PREBUILT" ]; then
    rustup target add x86_64-pc-windows-msvc >/dev/null
    if ! command -v cargo-xwin >/dev/null 2>&1; then
        echo "==> installing cargo-xwin"
        cargo install --locked cargo-xwin
    fi
fi

rm -rf "$OUT"
mkdir -p "$OUT"
cd "$APP"

# The launcher UI, once. tauri.conf.json's beforeBuildCommand would build it per `tauri build` invocation, and
# this script invokes tauri twice against ONE frontendDist — so the Windows pass re-ran vue-tsc + vite over
# bytes the Linux pass had already produced (34s + 14s, release job 15686372011). Built here instead, and
# switched off in the config below for both passes; an empty beforeBuildCommand is how tauri is told to skip it.
echo "==> building the launcher UI"
pnpm --filter @intentic/desktop-app build

# A configured pubkey + createUpdaterArtifacts makes `tauri build` demand the private key — so when the CI
# variable is absent, updater artifacts must be switched off for the build to succeed at all.
NO_BEFORE_BUILD='"build":{"beforeBuildCommand":""}'
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    CONFIG="{\"version\":\"${VERSION}\",${NO_BEFORE_BUILD}}"
else
    CONFIG="{\"version\":\"${VERSION}\",${NO_BEFORE_BUILD},\"bundle\":{\"createUpdaterArtifacts\":false}}"
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

if [ "$WINDOWS_ONLY" -eq 0 ]; then
    echo "==> building Linux bundles (deb, rpm, appimage)"
    pnpm exec tauri build --config "$CONFIG" --bundles deb,rpm,appimage
fi

if [ "$LINUX_ONLY" -eq 0 ] && [ -z "$WINDOWS_PREBUILT" ]; then
    echo "==> building Windows NSIS installer (cargo-xwin)"
    pnpm exec tauri build --config "$CONFIG" --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
fi

# --- collect with stable (un-versioned) names, so the site's vanity URLs and latest.json never need a bump ---
if [ "$WINDOWS_ONLY" -eq 0 ]; then
    cp "$LINUX_BUNDLES"/appimage/*.AppImage "$OUT/Intentic.AppImage"
    cp "$LINUX_BUNDLES"/deb/*.deb "$OUT/Intentic.deb"
    cp "$LINUX_BUNDLES"/rpm/*.rpm "$OUT/Intentic.rpm"
    appimage_signatures=("$LINUX_BUNDLES"/appimage/*.AppImage.sig)
    if [ -f "${appimage_signatures[0]}" ]; then
        cp "${appimage_signatures[0]}" "$OUT/Intentic.AppImage.sig"
    fi
fi
if [ -n "$WINDOWS_PREBUILT" ]; then
    cp "$WINDOWS_PREBUILT/Intentic-setup.exe" "$OUT/Intentic-setup.exe"
    if [ -f "$WINDOWS_PREBUILT/Intentic-setup.exe.sig" ]; then
        cp "$WINDOWS_PREBUILT/Intentic-setup.exe.sig" "$OUT/Intentic-setup.exe.sig"
    fi
elif [ "$LINUX_ONLY" -eq 0 ]; then
    cp "$WIN_BUNDLES"/nsis/*-setup.exe "$OUT/Intentic-setup.exe"
    windows_signatures=("$WIN_BUNDLES"/nsis/*-setup.exe.sig)
    if [ -f "${windows_signatures[0]}" ]; then
        cp "${windows_signatures[0]}" "$OUT/Intentic-setup.exe.sig"
    fi
fi

# --- updater manifest (only when the artifacts were signed) ---
# Never on a one-sided build, in EITHER direction: the manifest names both platforms, so a run that produced
# only one of them would advertise an update that 404s for everyone on the other.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ "$LINUX_ONLY" -eq 0 ] && [ "$WINDOWS_ONLY" -eq 0 ]; then
    echo "==> writing latest.json"
    if [ ! -f "$OUT/Intentic.AppImage.sig" ] || [ ! -f "$OUT/Intentic-setup.exe.sig" ]; then
        echo "error: updater signing is enabled but a staged desktop signature is missing" >&2
        exit 1
    fi
    appimage_sig="$(cat "$OUT/Intentic.AppImage.sig")"
    nsis_sig="$(cat "$OUT/Intentic-setup.exe.sig")"
    cat >"$OUT/latest.json" <<MANIFEST
{
    "version": "${VERSION}",
    "notes": "https://github.com/intentic/intentic/releases/tag/v${VERSION}",
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

rm -f "$OUT/SHA256SUMS"
(cd "$OUT" && sha256sum ./*) >"$OUT/SHA256SUMS"
echo "==> desktop artifacts:"
ls -lh "$OUT"

# Verify what was just built before anything publishes it. Here rather than as a separate CI step because this
# is the only place every release artifact exists at once, and because a bundle that shipped without its
# scripts — or without the intentic:// registration — is not a thing to discover after the GitHub Release is
# cut. Seconds, no Docker, no display; see the script's header for the two regression classes.
bash "$ROOT/_tools/scripts/verify-desktop-bundle.sh" "$OUT"
