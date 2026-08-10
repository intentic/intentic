#!/usr/bin/env bash
# Verify what a built desktop installer actually CONTAINS, without installing or launching anything.
#
#   verify-desktop-bundle.sh [<dist-bin dir>]        # default: _editor/desktop-app/dist-bin
#
# Two regression classes, both invisible to `tauri build` (which succeeds happily either way) and both of which
# reach a user as "the app installed and then could not do the thing":
#
#   1. A SCRIPT DID NOT SHIP. tauri.conf.json bundles `_site/site/public/scripts/*` by GLOB, which is what makes
#      "a script added to the site is bundled by construction" true — and also what makes it silently untrue the
#      day the glob is narrowed, a build runs against a stale checkout, or a bundler drops a file it cannot
#      stat. The app spawns these by basename at run time, so a missing one is a launcher button that fails only
#      once a user presses it. Every script the COMMIT carries must be present AND byte-identical.
#
#   2. THE DEEP LINK IS NOT REGISTERED. `intentic://` is the entire channel from the SPA into the app — setup,
#      recreate, sign-in, and the credential coming back. On the installed paths that registration is a
#      `x-scheme-handler/intentic` MIME entry in the .desktop file, written by the bundler from
#      tauri.conf.json's `plugins.deep-link`. Nothing else in the pipeline reads that config, so a bad edit
#      there produces a perfectly working build whose sign-in never returns. The MIME entry is only half of it:
#      an Exec line with no `%u` field code is launched with no arguments, so the entry wins the handler lookup
#      and then drops the link — see _editor/desktop-app/src-tauri/main.desktop. Both halves are asserted.
#
# This is deliberately the cheap tier: it is pure archive inspection, runs in seconds, needs no display, no
# Docker and no privileges — and it is the ONLY automated check that reaches inside the Windows NSIS installer,
# which is cross-built by cargo-xwin and never otherwise opened before it reaches a user.
set -euo pipefail
. "$(dirname "$0")/repo-root.sh"
. "$(dirname "$0")/desktop-artifacts.sh"

ROOT="$(repo_root)"
SOURCE_REL="_site/site/public/scripts"

if [ ! -d "${1:-$ROOT/_editor/desktop-app/dist-bin}" ]; then
    echo "error: no artifact directory at ${1:-$ROOT/_editor/desktop-app/dist-bin} — build first (build-desktop.sh or stage-local-downloads.sh)" >&2
    exit 1
fi
# Absolute, because the extractors run from inside their own output directory.
DIST="$(cd "${1:-$ROOT/_editor/desktop-app/dist-bin}" && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
checked=0

fail() {
    echo "  ✗ $1" >&2
    failures=$((failures + 1))
}

need() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "error: $1 is required to inspect $2 — install it and re-run." >&2
        exit 1
    }
}

# The scripts as the COMMIT carries them, extracted once — not as they happen to sit in the working tree. The
# runners keep their checkout between jobs (`clean: false`, docs/ci-runner.md) and share the machine with five
# others, so what is on disk can hold an untracked leftover, and it can CHANGE while the six-minute bundle build
# runs: in job 92707727494 the .deb was packed with a cleanup.sh that the .rpm, bundled two seconds later, no
# longer saw — three correct installers, a tree that moved under them, and a red build. A release ships what the
# commit says, so that is the thing worth asserting; a dirty working tree is the developer's business, not this
# script's.
git -C "$ROOT" archive HEAD "$SOURCE_REL" | tar -x -C "$WORK"
SOURCE_SCRIPTS="$WORK/$SOURCE_REL"

# Every script the site ships, by basename. This is the expectation the glob is supposed to satisfy.
mapfile -t EXPECTED < <(find "$SOURCE_SCRIPTS" -maxdepth 1 -type f -printf '%f\n' | sort)
if [ "${#EXPECTED[@]}" -eq 0 ]; then
    echo "error: no scripts committed at $SOURCE_REL — the source of truth is empty, which cannot be right." >&2
    exit 1
fi

# The bundled `scripts/` directory inside an extracted payload. Found rather than hardcoded: each bundler lays
# resources out under its own prefix (/usr/lib/<product>/ for deb and rpm, an AppDir root, $INSTDIR for nsis),
# and pinning four paths here would make this script the next thing that breaks when a bundler moves one.
find_scripts_dir() {
    find "$1" -type d -name scripts -exec test -e '{}/connect.sh' ';' -print -quit
}

# The comparison itself: present, and identical. Applied to whatever an extractor produced.
compare_scripts() {
    local label="$1" root="$2" dir
    dir="$(find_scripts_dir "$root")"
    if [ -z "$dir" ]; then
        fail "$label: no bundled scripts/ directory (looked for one containing connect.sh)"
        return
    fi
    local problems=0
    for name in "${EXPECTED[@]}"; do
        if [ ! -f "$dir/$name" ]; then
            fail "$label: $name did not ship"
            problems=$((problems + 1))
        elif ! cmp -s "$SOURCE_SCRIPTS/$name" "$dir/$name"; then
            fail "$label: $name differs from the committed $SOURCE_REL/$name"
            problems=$((problems + 1))
        fi
    done
    # A file in the bundle that the commit does not carry means the build read a stale tree — the app would spawn
    # a script nobody can review at its source path any more.
    while IFS= read -r name; do
        if ! printf '%s\n' "${EXPECTED[@]}" | grep -qxF "$name"; then
            fail "$label: stale $name is bundled but is not committed at $SOURCE_REL"
            problems=$((problems + 1))
        fi
    done < <(find "$dir" -maxdepth 1 -type f -printf '%f\n')
    if [ "$problems" -eq 0 ]; then
        echo "  ✓ $label: all ${#EXPECTED[@]} scripts present and identical"
    fi
}

# The deep-link scheme, as the installed desktop entry declares it. Absent ⇒ the OS routes `intentic://` nowhere
# and every link in the table in _editor/desktop-app/README.md is dead.
compare_desktop_entry() {
    local label="$1" root="$2" entry
    entry="$(find "$root" -type f -name '*.desktop' -print -quit)"
    if [ -z "$entry" ]; then
        fail "$label: no .desktop entry in the payload"
        return
    fi
    if grep -q '^MimeType=.*x-scheme-handler/intentic' "$entry"; then
        echo "  ✓ $label: $(basename "$entry") registers x-scheme-handler/intentic"
    else
        fail "$label: $(basename "$entry") does not register x-scheme-handler/intentic — deep links would not route"
    fi
    # The url has to survive the launch as well as reach the right binary. A handler entry whose Exec carries no
    # %u/%U is started with an EMPTY argv (desktop-entry spec, "The Exec key"), which is indistinguishable from a
    # user opening the app from the menu — the link is not delivered anywhere, it stops existing.
    if grep -qE '^Exec=.*%[uU]([[:space:]]|$)' "$entry"; then
        echo "  ✓ $label: $(basename "$entry") passes the url to the app (%u)"
    else
        fail "$label: $(basename "$entry") has no %u in Exec — the OS would start the app without the link"
    fi
}

check_deb() {
    local deb="$1" out="$WORK/deb"
    need dpkg-deb "the .deb"
    mkdir -p "$out"
    dpkg-deb --fsys-tarfile "$deb" | tar -x -C "$out"
    compare_scripts "deb" "$out"
    compare_desktop_entry "deb" "$out"
    checked=$((checked + 1))
}

check_rpm() {
    local rpm="$1" out="$WORK/rpm"
    # rpm2archive, not rpm2cpio: on the rpm tauri writes, rpm2cpio emits the COMPLETE payload and then exits 1
    # anyway (the package is sound — `rpm -K` verifies both digests and `rpm -i` installs it), which under
    # `pipefail` aborted this script with nothing printed. rpm2archive ships in the same `rpm` package, is what
    # upstream points at now, and needs no cpio.
    need rpm2archive "the .rpm"
    mkdir -p "$out"
    rpm2archive -n <"$rpm" | tar -x -C "$out"
    compare_scripts "rpm" "$out"
    compare_desktop_entry "rpm" "$out"
    checked=$((checked + 1))
}

check_appimage() {
    local image="$1" out="$WORK/appimage"
    mkdir -p "$out"
    # --appimage-extract is the runtime's own self-extract; it needs no FUSE, which CI containers do not have.
    chmod +x "$image"
    (cd "$out" && "$image" --appimage-extract >/dev/null)
    compare_scripts "appimage" "$out"
    # NOTE: the AppImage's .desktop entry is what its runtime integration reads, but nothing installs it — the
    # app registers the scheme itself at startup (lib.rs). The entry is still asserted: it is what a desktop
    # integrator (appimaged, Gear Lever) would install, and the runtime registration is the fallback, not the plan.
    compare_desktop_entry "appimage" "$out"
    checked=$((checked + 1))
}

check_nsis() {
    local exe="$1" out="$WORK/nsis"
    need 7z "the NSIS installer"
    mkdir -p "$out"
    # NSIS installers are a readable archive format to 7z. This is the only look inside the Windows artifact
    # anything in this pipeline gets: it is cross-built by cargo-xwin on a Linux runner and, until a Windows
    # runner exists, never executed before a user runs it.
    7z x -o"$out" -y "$exe" >/dev/null
    compare_scripts "nsis" "$out"
    # No .desktop file on Windows — the scheme is a registry key the installer writes at install time, which is
    # only observable by installing. That assertion lives in @intentic/desktop-smoke-windows, which installs
    # this same artifact on a real Windows session and reads the key back before the app has ever run.
    checked=$((checked + 1))
}

echo "==> verifying desktop bundles in ${DIST#"$ROOT"/}"
echo "    against the ${#EXPECTED[@]} scripts committed at $SOURCE_REL ($(git -C "$ROOT" rev-parse --short HEAD))"

# Found by kind rather than by name: the version in each file name belongs to the build being verified, which
# is not something this script is told. `if` rather than `[ -n … ] && check_…`: under `set -e` a trailing
# AND-list whose test is false exits the script non-zero, so an absent Windows artifact — the normal state of
# a --linux-only build — would read as a verification failure.
deb="$(desktop_artifact "$DIST" deb)"
rpm="$(desktop_artifact "$DIST" rpm)"
appimage="$(desktop_artifact "$DIST" appimage)"
nsis="$(desktop_artifact "$DIST" nsis)"
if [ -n "$deb" ]; then check_deb "$deb"; fi
if [ -n "$rpm" ]; then check_rpm "$rpm"; fi
if [ -n "$appimage" ]; then check_appimage "$appimage"; fi
if [ -n "$nsis" ]; then check_nsis "$nsis"; fi

if [ "$checked" -eq 0 ]; then
    echo "error: no known artifacts in $DIST (expected $(desktop_artifact_glob deb) / $(desktop_artifact_glob rpm) / $(desktop_artifact_glob appimage) / $(desktop_artifact_glob nsis))" >&2
    exit 1
fi

if [ "$failures" -gt 0 ]; then
    echo
    echo "==> $failures problem(s) across $checked bundle(s)" >&2
    exit 1
fi
echo "==> $checked bundle(s) verified"
