#!/usr/bin/env bash
# Put the `ic` CLI where the desktop app's bundlers look for it: src-tauri/binaries/intentic-ic-<triple>[.exe], the
# name tauri.conf.json's second `externalBin` resolves to, and which every installer puts beside the app as
# intentic-ic / intentic-ic.exe.
#
# NEVER AS `ic`. The deb and the rpm put every `externalBin` in /usr/bin, so a sidecar called `ic` would be on every
# PATH, ahead of the newer ic the machine agent keeps in ~/.intentic/ic/bin (and a file another package may own). Under
# its own name nothing finds it but the app; the shims copy it to ~/.intentic/ic/bin/ic[.exe], where it is `ic` again.
# Its --version still answers `ic <version>`: clap prints the command's name (main.rs), not the file's.
#
#   stage-desktop-ic.sh [<triple>...]                      # cargo checks and `tauri dev` (this host's triple by default)
#   stage-desktop-ic.sh --bundle [<triple>...]             # an installer: a real ic or nothing
#   stage-desktop-ic.sh --release <version> [<triple>...]  # a release's installer: exactly that release's ic
#
# WHY THE INSTALLER CARRIES IT. Every flow the app runs is a shim (connect, recreate, fix, connect-host) whose first
# act was downloading this same release's `ic` from GitHub, so a first setup could not start on a network that
# blocks or throttles github.com, and failed there before anything else had worked. The app now names the copy beside
# its own executable to every script it runs (commands.rs `app_env`, INTENTIC_IC_PATH), and a shim pinned to the
# app's release copies that file into ~/.intentic/ic/bin instead of downloading it, when it answers --version with
# exactly that release. The download stays the fallback, and the only path for the public one-liners.
#
# WHERE EACH MODE TAKES IT FROM, by how much rides on the answer:
#
#   --release   _sandbox/ic/dist-bin/ic-<os>-<arch>[.exe] and nothing else: what `build-ic.sh --version <version>`
#               wrote, which in release.yml is the ic-build job's artifact downloaded into that directory. The
#               installer has to carry the bytes the release attaches for the shims to download, so this never builds
#               one of its own, and it refuses a binary that is not <version>: asked with --version where this host
#               can run it, and looked for in its bytes where it cannot (the stamp is a string literal, main.rs
#               `VERSION`).
#   --bundle    the same file when it is newer than every source of the crate, else build-ic.sh builds it now: the
#               shipping toolchain (static musl on Linux, which the glibc floor has nothing to say about; cargo-xwin
#               for Windows), so a CI or local installer carries the binary a release would. Unstamped, so it says
#               0.0.0 like the rest of a working-tree build. If that fails, this fails: an installer missing the
#               binary every one of its scripts reaches for is not one to hand anybody.
#   (neither)   a cargo build of the crate for this host, the debug build connect.sh's checkout path runs too (cargo
#               rebuilds only what changed, so an existing one costs nothing), or a dist-bin binary for another
#               triple. Where neither can be had, a PLACEHOLDER, said out loud: tauri-build only checks that the file
#               exists (`cargo clippy`, `cargo test`), and no shim ever copies a placeholder, because it copies only an
#               ic whose --version is the run's IC_VERSION.
#
# Every cargo command against the app needs this staged, as it needs stage-local-files.sh and stage-desktop-scripts.sh,
# so the app's Rust scripts and every bundle build run it first.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"

ROOT="$(repo_root)"
BINARIES="$ROOT/_editor/desktop-app/src-tauri/binaries"
CRATE="$ROOT/_sandbox/ic"
DIST="$CRATE/dist-bin"

MODE=check
RELEASE=""
case "${1:-}" in
    --bundle)
        MODE=bundle
        shift
        ;;
    --release)
        MODE=release
        RELEASE="${2:?usage: stage-desktop-ic.sh --release <version> [<triple>...]}"
        shift 2
        ;;
esac

triples=("$@")
if [ "${#triples[@]}" -eq 0 ]; then
    triples=("$(rustc -vV | sed -n 's/^host: //p')")
fi
HOST="$(rustc -vV 2>/dev/null | sed -n 's/^host: //p' || true)"

# What this machine can execute, in build-ic.sh's own spelling of it, so a release binary for this host is asked
# its version rather than searched for it.
native_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
native_arch="$(uname -m)"
case "$native_arch" in
    x86_64 | amd64) native_arch=amd64 ;;
    arm64 | aarch64) native_arch=arm64 ;;
esac

# The ic release asset that serves an app built for <triple>, as "<build-ic.sh target> <asset name>". The Linux app
# is a glibc build and its ic a static musl one, which runs on any Linux of the same CPU, so both libcs map to it.
asset_for() {
    case "$1" in
        x86_64-unknown-linux-gnu | x86_64-unknown-linux-musl) echo "linux-x64 ic-linux-amd64" ;;
        aarch64-unknown-linux-gnu | aarch64-unknown-linux-musl) echo "linux-arm64 ic-linux-arm64" ;;
        x86_64-pc-windows-msvc) echo "windows-x64 ic-windows-amd64.exe" ;;
        x86_64-apple-darwin) echo "darwin-x64 ic-darwin-amd64" ;;
        aarch64-apple-darwin) echo "darwin-arm64 ic-darwin-arm64" ;;
        *) return 1 ;;
    esac
}

# A dist-bin binary older than any file of the crate (its sources, manifest, lockfile, path dependencies) was
# built from a different tree, and a local installer that quietly carries last month's ic is the bug.
fresh() {
    [ -f "$1" ] || return 1
    [ -z "$(find "$CRATE" \( -name target -o -name dist-bin \) -prune -o -type f -newer "$1" -print -quit)" ]
}

# Into place only when the bytes differ: tauri-build reruns the app's build script whenever this file's mtime moves
# (it asks cargo to watch it), and a `pnpm test:rust` that changed nothing should not cost a rebuild of the app.
put() {
    if ! cmp -s "$1" "$2"; then
        cp "$1" "$2"
    fi
    # The bundlers carry this mode into the package, and artifacts lose theirs between jobs.
    chmod 755 "$2"
}

placeholder() {
    local out="$1" why="$2"
    echo "warning: staging a PLACEHOLDER for ic at ${out#"$ROOT"/} ($why). Enough for cargo checks and tauri dev; a bundle needs --bundle." >&2
    printf '#!/bin/sh\necho "ic: a placeholder staged by stage-desktop-ic.sh for cargo checks; no real ic was built for this target." >&2\nexit 1\n' >"$out.tmp"
    put "$out.tmp" "$out"
    rm -f "$out.tmp"
}

mkdir -p "$BINARIES"
for triple in "${triples[@]}"; do
    ext=""
    case "$triple" in *windows*) ext=".exe" ;; esac
    out="$BINARIES/intentic-ic-$triple$ext"
    spec="$(asset_for "$triple" || true)"
    target="${spec%% *}"
    asset="${spec#* }"

    case "$MODE" in
        release)
            if [ -z "$asset" ]; then
                echo "error: ic has no release build for $triple; add it to build-ic.sh and asset_for here first." >&2
                exit 1
            fi
            if [ ! -f "$DIST/$asset" ]; then
                echo "error: no $asset in ${DIST#"$ROOT"/} for v$RELEASE, so the installer would ship without ic. \`bash _tools/scripts/build/build-ic.sh --version $RELEASE $target\` makes it; in release.yml it is the ic-build job's artifact, downloaded there before this runs." >&2
                exit 1
            fi
            echo "==> ic for $triple: $asset, the release's own"
            # Checked before it takes the staged name; a refused one takes whatever was staged there with it, so no
            # bundler picks up a binary this run did not approve.
            cp "$DIST/$asset" "$out.tmp"
            chmod 755 "$out.tmp"
            if [ "$asset" = "ic-${native_os}-${native_arch}" ]; then
                said="$("$out.tmp" --version 2>/dev/null || true)"
                if [ "$said" != "ic $RELEASE" ]; then
                    rm -f "$out.tmp" "$out"
                    echo "error: $asset reports '$said', not 'ic $RELEASE': a binary from another build is in ${DIST#"$ROOT"/}." >&2
                    exit 1
                fi
            elif ! LC_ALL=C grep -qaF "$RELEASE" "$out.tmp"; then
                rm -f "$out.tmp" "$out"
                echo "error: $asset does not carry the version $RELEASE anywhere in its bytes: a binary from another build is in ${DIST#"$ROOT"/}." >&2
                exit 1
            fi
            put "$out.tmp" "$out"
            rm -f "$out.tmp"
            ;;
        bundle)
            if [ -z "$asset" ]; then
                echo "error: ic has no build for $triple; add it to build-ic.sh and asset_for here first." >&2
                exit 1
            fi
            if fresh "$DIST/$asset"; then
                echo "==> ic for $triple: ${DIST#"$ROOT"/}/$asset, built from this tree"
            else
                echo "==> ic for $triple: building it (build-ic.sh $target)"
                if ! bash "$ROOT/_tools/scripts/build/build-ic.sh" "$target" || [ ! -f "$DIST/$asset" ]; then
                    echo "error: could not build ic for $triple, and an installer without it is not one to ship. build-ic.sh's header lists the toolchain $target needs." >&2
                    exit 1
                fi
            fi
            put "$DIST/$asset" "$out"
            ;;
        check)
            if [ "$triple" = "$HOST" ]; then
                echo "==> ic for $triple: a cargo build of ${CRATE#"$ROOT"/}"
                built="${CARGO_TARGET_DIR:-$CRATE/target}/debug/ic$ext"
                if command -v cargo >/dev/null 2>&1 && cargo build --manifest-path "$CRATE/Cargo.toml" && [ -f "$built" ]; then
                    put "$built" "$out"
                else
                    placeholder "$out" "the crate did not build for this host"
                fi
            elif [ -n "$asset" ] && [ -f "$DIST/$asset" ]; then
                echo "==> ic for $triple: ${DIST#"$ROOT"/}/$asset"
                put "$DIST/$asset" "$out"
            else
                placeholder "$out" "nothing built for $triple; build-ic.sh ${target:-<target>} would make one"
            fi
            ;;
    esac
done
