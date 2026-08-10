#!/usr/bin/env bash
# What a desktop artifact is CALLED — the one place that decides, for every script that builds, verifies,
# stages or publishes one.
#
# The names carry the version and the architecture: Intentic-1.15.1-x64-setup.exe, not Intentic-setup.exe. A
# file that states what it is survives being copied to a colleague, sitting in a Downloads folder next to
# three of its own predecessors, or arriving in a bug report with nothing else attached — and a fixed name
# survives none of that. It is also what lets someone answer "which build did you install?" without opening
# anything.
#
# The architecture is spelled the way each platform's OWN tooling spells 64-bit Intel/AMD, because these names
# are read by that tooling's users: `x64` is Microsoft's, `amd64` is Debian's, `x86_64` is RPM's and
# AppImage's. One repo-wide spelling would be tidier here and wrong everywhere it is read. Adding a second
# architecture later means adding a case, not renaming what already ships.
#
# Nothing downstream may hardcode these. Source this file and ask:
#
#   . "$(dirname "$0")/desktop-artifacts.sh"
#   name="$(desktop_artifact_name nsis "$VERSION")"   # building: the exact name to write
#   file="$(desktop_artifact "$DIST" deb)"            # consuming: whichever version is in that directory
#
# The one name NOT here is latest.json. The updater fetches it from `releases/latest/download/latest.json`,
# which resolves only for a name that never changes — so the manifest is fixed and the installers it points at
# are versioned, which is the right way round: the pointer is stable, the things it points at are identifiable.

# The four kinds, as the bundlers produce them and as the release attaches them.
DESKTOP_ARTIFACT_KINDS="nsis appimage deb rpm"

# The artifact name for a kind at a version. Pass '*' as the version for a glob (desktop_artifact_glob).
desktop_artifact_name() {
    case "$1" in
        nsis) printf 'Intentic-%s-x64-setup.exe\n' "$2" ;;
        appimage) printf 'Intentic-%s-x86_64.AppImage\n' "$2" ;;
        deb) printf 'Intentic-%s-amd64.deb\n' "$2" ;;
        rpm) printf 'Intentic-%s-x86_64.rpm\n' "$2" ;;
        *)
            echo "desktop-artifacts.sh: unknown artifact kind '$1' (expected one of: $DESKTOP_ARTIFACT_KINDS)" >&2
            return 2
            ;;
    esac
}

# The same name with the version left open, for finding one whose version this caller does not know.
desktop_artifact_glob() {
    desktop_artifact_name "$1" '*'
}

# The single artifact of a kind in a directory, or empty when there is none.
#
# Empty is a legitimate answer and the reason this prints rather than fails: every consumer builds a subset
# (--linux-only leaves no installer, --windows-only leaves no bundles) and asks about all four. TWO matches is
# never legitimate — the build directory is emptied per build, so a second one means a stale artifact from a
# previous version is about to be published or verified in place of the fresh one, and guessing between them
# is exactly the failure this naming scheme exists to prevent.
desktop_artifact() {
    local _dir="$1" _pattern _candidate
    local -a _matches=()
    _pattern="$(desktop_artifact_glob "$2")" || return 2
    for _candidate in "$_dir"/$_pattern; do
        [ -f "$_candidate" ] && _matches+=("$_candidate")
    done
    if [ "${#_matches[@]}" -gt 1 ]; then
        echo "desktop-artifacts.sh: ${#_matches[@]} '$2' artifacts in $_dir (${_matches[*]##*/}) — expected one; clear the stale build" >&2
        return 1
    fi
    [ "${#_matches[@]}" -eq 1 ] && printf '%s\n' "${_matches[0]}"
    return 0
}
