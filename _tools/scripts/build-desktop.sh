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
# Analytics: POSTHOG_KEY is baked into the launcher UI here (desktop-app/vite.config.ts), because a compiled
# app has no container entrypoint to substitute one at start the way the web image does. Unset — which is
# every local build and every CI/nightly build — leaves the app's own analytics off, so only installers a user
# actually downloads report anything. Nothing about the workspace window depends on it: that face is the
# hosted SPA and carries the key its own deployment was given.
#
# The artifacts land in _editor/desktop-app/dist-bin/, from where publish-github.sh attaches them to the GitHub
# Release — the download surface the site and the updater both point at.
set -euo pipefail

VERSION="${1:?usage: build-desktop.sh <version> [--linux-only|--windows-only|--windows-prebuilt <dir>|--assemble <windows-dir>]}"
. "$(dirname "$0")/repo-root.sh"
. "$(dirname "$0")/desktop-artifacts.sh"
# Two verification jobs each want ONE side of this build, the release's linux-build job wants the Linux side,
# and the publish wants the assembled whole. One build script either way, so the artifacts a CI job verifies
# are produced by exactly the path that produces the released ones.
#
#   --linux-only    skips the Windows cross-build and the cargo-xwin toolchain it needs. For desktop-verify
#                   and the release's linux-build job, which exercise the Linux bundles on a real host and
#                   have no use for an installer they cannot run.
#   --windows-only  skips the Linux bundles. For the job that hands the NSIS installer to the Windows runner:
#                   a deb/rpm/AppImage build costs it several minutes of artifacts nothing downstream opens.
#   --windows-prebuilt <dir>
#                   builds Linux and stages the already-tested NSIS candidate from this directory, so Windows
#                   approves the bytes publish-github.sh actually attaches.
#   --assemble <windows-dir>
#                   builds NOTHING: the Linux bundles are already in dist-bin (the release's linux-build job
#                   built, verified and shipped them as an artifact), and the NSIS candidate is staged from
#                   this directory. What remains is the release-set work only the final job can do — the
#                   updater manifest, the checksums, and the archive verification over the complete set.
#                   This is the one mode that cannot empty dist-bin first — its inputs are already in it — so
#                   the CALLER owes it a directory holding nothing but this release's artifacts. On a runner
#                   that keeps its checkout, that means deleting the directory before the artifacts are
#                   downloaded into it (release.yml's publish job), or the previous build's bundles are
#                   assembled, verified and published alongside this one's.
#
# Only a run that ends holding BOTH platforms writes latest.json — a manifest naming a platform whose
# installer the run did not produce would advertise an update that 404s, and that is true in both directions.
LINUX_ONLY=0
WINDOWS_ONLY=0
ASSEMBLE=0
WINDOWS_PREBUILT=""
case "${2:-}" in
    --linux-only) LINUX_ONLY=1 ;;
    --windows-only) WINDOWS_ONLY=1 ;;
    --windows-prebuilt)
        WINDOWS_PREBUILT="${3:?usage: build-desktop.sh <version> --windows-prebuilt <dir>}"
        ;;
    --assemble)
        ASSEMBLE=1
        WINDOWS_PREBUILT="${3:?usage: build-desktop.sh <version> --assemble <windows-dir>}"
        ;;
    "") ;;
    *)
        echo "error: unknown flag '${2}' (expected --linux-only, --windows-only, --windows-prebuilt <dir>, or --assemble <windows-dir>)" >&2
        exit 2
        ;;
esac
# What this build's four artifacts are called (desktop-artifacts.sh) — resolved once, here, so the collect and
# the manifest below cannot drift from each other or from what the release attaches.
NSIS_NAME="$(desktop_artifact_name nsis "$VERSION")"
APPIMAGE_NAME="$(desktop_artifact_name appimage "$VERSION")"
DEB_NAME="$(desktop_artifact_name deb "$VERSION")"
RPM_NAME="$(desktop_artifact_name rpm "$VERSION")"
# A prebuilt candidate is looked for by its EXACT versioned name, not by whatever installer happens to be in
# that directory. It was built by an earlier job at a version this run was told to release, so a name that does
# not match means the two disagree about what is being released — and staging it anyway would attach an
# installer whose contents claim one version under a file name promising another.
if [ -n "$WINDOWS_PREBUILT" ] && [ ! -f "$WINDOWS_PREBUILT/$NSIS_NAME" ]; then
    echo "error: no $NSIS_NAME in $WINDOWS_PREBUILT — the tested candidate is missing, or was built at a different version" >&2
    exit 2
fi
# A RELEASE WITHOUT THE SIGNING KEY IS A RELEASE NOBODY CAN BE UPDATED TO, and it used to be a line of output.
#
# The tail of this script skips the .sig files and latest.json when TAURI_SIGNING_PRIVATE_KEY is unset, prints
# "no auto-update for this release", and exits green. That is exactly right for the CI and nightly builds,
# which pass 0.0.0 and exist to prove the bundles install — and it is how every release up to and including
# v1.213.0 shipped with a 404 where its manifest should be. No copy in the wild was ever offered an update, the
# app said "it installs the next time you quit" over the top of it, and the pipeline was green throughout.
#
# A version that is not the 0.0.0 sentinel is a release. Refuse it here, before several minutes of building,
# rather than announcing it afterwards.
if [ "$VERSION" != "0.0.0" ] && [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    echo "error: releasing v${VERSION} with no TAURI_SIGNING_PRIVATE_KEY — the build would publish installers with no latest.json, and no copy of the app could ever update itself onto them. Set the secret, or build at 0.0.0 to verify the bundles without releasing." >&2
    exit 2
fi

ROOT="$(repo_root)"
APP="$ROOT/_editor/desktop-app"
TAURI_DIR="$APP/src-tauri"
OUT="$APP/dist-bin"
# Where the updater fetches an installer FROM: the GitHub Release for this exact version, so a manifest always
# points at the build it describes.
DOWNLOADS="https://github.com/intentic/intentic/releases/download/v${VERSION}"

echo "==> desktop release build v${VERSION}"

# The assemble path builds nothing, so it wants none of the toolchain below — it validates that the
# linux-build job's artifact is actually in place (by exact versioned name, same reasoning as the Windows
# candidate check above: a name that does not match means two jobs disagree about what is being released),
# stages the Windows candidate, and falls through to the manifest + checksums + verification tail.
if [ "$ASSEMBLE" -eq 1 ]; then
    for name in "$APPIMAGE_NAME" "$DEB_NAME" "$RPM_NAME"; do
        if [ ! -f "$ROOT/_editor/desktop-app/dist-bin/$name" ]; then
            echo "error: no $name in dist-bin — the linux-build artifact is missing, or was built at a different version" >&2
            exit 2
        fi
    done
    # Actions artifacts do not preserve file modes, and the verification at the end of this script EXECUTES
    # the AppImage (--appimage-extract, its runtime's own self-extract). Harmless to users — the download
    # surfaces chmod what they fetch — fatal to the verifier without this.
    chmod +x "$ROOT/_editor/desktop-app/dist-bin/$APPIMAGE_NAME"
fi

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
if [ "$ASSEMBLE" -eq 0 ] &&
    { ! command -v makensis >/dev/null 2>&1 || ! command -v xdg-mime >/dev/null 2>&1 ||
        ! command -v file >/dev/null 2>&1 ||
        ! command -v 7z >/dev/null 2>&1 || ! command -v rpm2archive >/dev/null 2>&1 ||
        ! dpkg -s libwebkit2gtk-4.1-dev >/dev/null 2>&1; }; then
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
if [ "$ASSEMBLE" -eq 0 ] && ! command -v cargo >/dev/null 2>&1; then
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

# Assembling starts from the artifacts already in $OUT, so it is the one mode that must NOT empty it.
if [ "$ASSEMBLE" -eq 0 ]; then
    rm -rf "$OUT"
fi
mkdir -p "$OUT"
cd "$APP"

if [ "$ASSEMBLE" -eq 0 ]; then
    # The scripts the installers carry, taken from the COMMIT (stage-desktop-scripts.sh says why). Called here
    # rather than left to the app's own `build` script, because the line below switches beforeBuildCommand off
    # for both bundle passes — and a release that stages nothing would bundle a directory that is empty or a
    # release older than this build.
    bash "$ROOT/_tools/scripts/stage-desktop-scripts.sh"
    # The launcher UI, once. tauri.conf.json's beforeBuildCommand would build it per `tauri build` invocation, and
    # this script invokes tauri twice against ONE frontendDist — so the Windows pass re-ran vue-tsc + vite over
    # bytes the Linux pass had already produced (34s + 14s, release job 15686372011). Built here instead, and
    # switched off in the config below for both passes; an empty beforeBuildCommand is how tauri is told to skip it.
    echo "==> building the launcher UI"
    pnpm --filter @intentic/desktop-app build
fi

# THE VERSION, INTO THE BINARY ITSELF. The `--config` override below stamps the installer and the updater
# manifest, and reaches Rust not at all — CARGO_PKG_VERSION is Cargo.toml's `0.0.0` in every build this repo
# cuts. src-tauri/build.rs turns this variable into `INTENTIC_VERSION`, which is what the app reports as its
# own version and, more importantly, what it pins its `ic` download to: an app that fetches
# `releases/latest` runs a CLI from a different release than its own bundled scripts, and the two then
# disagree about a protocol neither of them mentions out loud.
export INTENTIC_VERSION="$VERSION"

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

# The signing key carries no password, and the signer WAITS FOR ONE unless it is told that in the environment:
# with the variable unset it prints "Signing without password." and then blocks on a prompt no CI job can
# answer, which is a release that hangs rather than one that fails. Defaulted rather than assigned, so a key
# that does have a password still signs with it.
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# Stale bundles from a previous (cached) build would make the glob-copies below ambiguous.
# Both CI jobs that run this set CARGO_TARGET_DIR to the shared /ci-cache store, and cargo puts the bundles
# under THAT — so the src-tauri/target spelling cleaned nothing and the copies below looked for artifacts in a
# directory the build never wrote to.
TARGET_DIR="${CARGO_TARGET_DIR:-$TAURI_DIR/target}"
LINUX_BUNDLES="$TARGET_DIR/release/bundle"
WIN_BUNDLES="$TARGET_DIR/x86_64-pc-windows-msvc/release/bundle"
if [ "$ASSEMBLE" -eq 0 ]; then
    rm -rf "$LINUX_BUNDLES" "$WIN_BUNDLES"
fi

if [ "$WINDOWS_ONLY" -eq 0 ] && [ "$ASSEMBLE" -eq 0 ]; then
    echo "==> building Linux bundles (deb, rpm, appimage)"
    pnpm exec tauri build --config "$CONFIG" --bundles deb,rpm,appimage
fi

if [ "$LINUX_ONLY" -eq 0 ] && [ -z "$WINDOWS_PREBUILT" ]; then
    echo "==> building Windows NSIS installer (cargo-xwin)"
    pnpm exec tauri build --config "$CONFIG" --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
fi

# --- collect under the names the release attaches (desktop-artifacts.sh: version + architecture) ---
# The bundlers each spell their own output differently and none of them agrees with the others, so the names
# are imposed here rather than inherited — which is also what makes every downstream consumer able to ask for
# an artifact by KIND and get one answer.
if [ "$WINDOWS_ONLY" -eq 0 ] && [ "$ASSEMBLE" -eq 0 ]; then
    cp "$LINUX_BUNDLES"/appimage/*.AppImage "$OUT/$APPIMAGE_NAME"
    cp "$LINUX_BUNDLES"/deb/*.deb "$OUT/$DEB_NAME"
    cp "$LINUX_BUNDLES"/rpm/*.rpm "$OUT/$RPM_NAME"
    appimage_signatures=("$LINUX_BUNDLES"/appimage/*.AppImage.sig)
    if [ -f "${appimage_signatures[0]}" ]; then
        cp "${appimage_signatures[0]}" "$OUT/$APPIMAGE_NAME.sig"
    fi
fi
if [ -n "$WINDOWS_PREBUILT" ]; then
    cp "$WINDOWS_PREBUILT/$NSIS_NAME" "$OUT/$NSIS_NAME"
    if [ -f "$WINDOWS_PREBUILT/$NSIS_NAME.sig" ]; then
        cp "$WINDOWS_PREBUILT/$NSIS_NAME.sig" "$OUT/$NSIS_NAME.sig"
    fi
elif [ "$LINUX_ONLY" -eq 0 ]; then
    cp "$WIN_BUNDLES"/nsis/*-setup.exe "$OUT/$NSIS_NAME"
    windows_signatures=("$WIN_BUNDLES"/nsis/*-setup.exe.sig)
    if [ -f "${windows_signatures[0]}" ]; then
        cp "${windows_signatures[0]}" "$OUT/$NSIS_NAME.sig"
    fi
fi

# --- updater manifest (only when the artifacts were signed) ---
# Never on a one-sided build, in EITHER direction: the manifest names both platforms, so a run that produced
# only one of them would advertise an update that 404s for everyone on the other.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ "$LINUX_ONLY" -eq 0 ] && [ "$WINDOWS_ONLY" -eq 0 ]; then
    echo "==> writing latest.json"
    if [ ! -f "$OUT/$APPIMAGE_NAME.sig" ] || [ ! -f "$OUT/$NSIS_NAME.sig" ]; then
        echo "error: updater signing is enabled but a staged desktop signature is missing" >&2
        exit 1
    fi
    appimage_sig="$(cat "$OUT/$APPIMAGE_NAME.sig")"
    nsis_sig="$(cat "$OUT/$NSIS_NAME.sig")"
    cat >"$OUT/latest.json" <<MANIFEST
{
    "version": "${VERSION}",
    "notes": "https://github.com/intentic/intentic/releases/tag/v${VERSION}",
    "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "platforms": {
        "linux-x86_64": { "signature": "${appimage_sig}", "url": "${DOWNLOADS}/${APPIMAGE_NAME}" },
        "windows-x86_64": { "signature": "${nsis_sig}", "url": "${DOWNLOADS}/${NSIS_NAME}" }
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
