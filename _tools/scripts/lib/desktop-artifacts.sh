#!/bin/sh
# Shared desktop artifact names include version and platform-native architecture spellings: x64, amd64 or x86_64.
# Use desktop_artifact_name to produce a name and desktop_artifact to locate one; callers must not hardcode installer names.
# Keep this library POSIX sh: workflow container steps source it under dash as well as Bash.
# latest.json stays fixed because releases/latest/download resolves that URL; only the installers it points at are versioned.

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
    local _dir _pattern _candidate _match _names _count
    _dir="$1" _match='' _names='' _count=0
    _pattern="$(desktop_artifact_glob "$2")" || return 2
    for _candidate in "$_dir"/$_pattern; do
        [ -f "$_candidate" ] || continue
        _count=$((_count + 1))
        _match="$_candidate"
        _names="$_names ${_candidate##*/}"
    done
    if [ "$_count" -gt 1 ]; then
        echo "desktop-artifacts.sh: $_count '$2' artifacts in $_dir (${_names# }) — expected one; clear the stale build" >&2
        return 1
    fi
    [ "$_count" -eq 1 ] && printf '%s\n' "$_match"
    return 0
}
