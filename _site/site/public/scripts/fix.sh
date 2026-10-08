#!/bin/sh
# intentic fix — bootstrap shim for the one command a sandbox that stopped answering hands out. The work itself
# lives in the `ic` CLI (_sandbox/ic, `ic sandbox fix`): it checks every layer of this machine between you and the
# sandbox (network, Docker, WSL, the disk, the container, its daemon), fixes what is safe to fix, asks in this
# terminal before anything disruptive, and says what is left for you. This script only fetches the binary and
# forwards:
#
#   curl -fsSL https://intentic.dev/fix | sh -s -- <CODE>          # the recovery panel's command
#   curl -fsSL https://intentic.dev/fix | sh                       # no code: every sandbox here, unobserved
#   sh fix.sh <CODE> --yes                                         # ic's own flags after the code, verbatim
#
# The CODE is the one the browser's recovery panel put in the command. It names the sandbox and lets this run
# report its progress back to that page; without it the run still fixes, the page just cannot watch it.
#
# The binary is downloaded on EVERY run, so the fix is always the latest one, whatever `ic` this machine had;
# only a failed download falls back to what's installed. IC_BIN overrides for local dev (a checkout's own build).
# A run the desktop app pins to its release copies the ic the app carries (INTENTIC_IC_PATH) instead, when that one
# is exactly the release asked for.
# POSIX sh (piped into `sh`, which is dash on Debian/Ubuntu/WSL — no `pipefail`). Piped, stdin is this script,
# so ic asks its questions on the controlling terminal (/dev/tty), never on stdin.
set -eu

if ! command -v curl >/dev/null 2>&1; then
    echo "error: curl is required — install it and re-run." >&2
    exit 1
fi

# THE CHECKOUT THIS SCRIPT WAS RUN OUT OF, or empty when there isn't one — which is the normal case, since the
# piped `curl … | sh` form has no path in $0 at all.
#
# Found by walking up to the workspace marker rather than counting a fixed number of levels. This file is
# served from two places in the repo (_site/site/public/scripts and the built _apps/site/dist/scripts), and a
# fixed `../../../..` is only right while both stay exactly four deep; a walk is right wherever it is served
# from, and survives being copied, moved or symlinked. The use below still GATES on finding the specific file
# it needs, so an unrelated checkout that happens to be a pnpm workspace falls through exactly as before.
# CANNOT be shared with _tools/scripts/lib/repo-root.sh: this file is downloaded and run on its own.
checkout_root() {
    case "$0" in
        */*) _dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || return 0 ;;
        *) return 0 ;; # piped curl|sh — no path, no checkout
    esac
    while [ -n "$_dir" ] && [ "$_dir" != "/" ]; do
        if [ -f "$_dir/pnpm-workspace.yaml" ]; then
            printf '%s\n' "$_dir"
            return 0
        fi
        _dir="$(dirname "$_dir")"
    done
}
CHECKOUT="$(checkout_root)"

# ---- fetch the ic CLI (keep in lockstep with connect.sh / connect-host.sh — standalone curl|sh files) ----
IC="${IC_BIN:-}"
# Run BY PATH from a checkout (the dev platform's one-liners, a hand-run in the repo), prefer the checkout's
# OWN ic — a flow change and its CLI change land in one commit and are tested together. The piped curl|sh
# form has no path in $0 and skips this; so does a checkout without cargo.
if [ -z "$IC" ] && [ -n "$CHECKOUT" ]; then
    ic_manifest="$CHECKOUT/_sandbox/ic/Cargo.toml"
    if [ -f "$ic_manifest" ] && command -v cargo >/dev/null 2>&1; then
        echo "intentic: building the checkout's ic CLI…"
        if cargo build --quiet --manifest-path "$ic_manifest"; then
            IC="$CHECKOUT/_sandbox/ic/target/debug/ic"
        else
            echo "intentic: warning — the checkout's ic build failed; falling back to the released ic." >&2
        fi
    fi
fi
if [ -z "$IC" ]; then
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    case "$os" in
        linux | darwin) ;;
        *)
            echo "error: unsupported OS '$os' — on Windows use the .ps1 one-liner from the same card." >&2
            exit 1
            ;;
    esac
    arch="$(uname -m)"
    case "$arch" in
        x86_64 | amd64) arch="amd64" ;;
        arm64 | aarch64) arch="arm64" ;;
        *)
            echo "error: unsupported CPU arch '$arch'." >&2
            exit 1
            ;;
    esac
    # Root installs system-wide; a user run installs per-user with an `ic` on PATH for later hand-typed use.
    if [ "$(id -u)" = 0 ]; then
        dest="/usr/local/bin/ic"
    else
        dest="$HOME/.intentic/ic/bin/ic"
        mkdir -p "$(dirname "$dest")"
    fi
    # A run pinned to a release (IC_VERSION beside IC_URL, which the desktop app sets to its own) that finds that
    # release OR A NEWER ONE installed has nothing to fetch: asking the binary costs milliseconds. Never "exactly that
    # release": the machine agent moves ic up by itself, so a desktop app left in the tray for days put an older ic
    # back on every Start, Stop or Restart it ran (2026-10-05). An unpinned run still downloads.
    #
    # Compared as versions: major.minor.patch first, then a pre-release below its own release. An installed ic whose
    # answer is not a version this can read counts as older, and is replaced.
    ic_not_older() {
        ic_seen="$("$1" --version 2>/dev/null || true)"
        ic_have="${ic_seen#ic }"
        ic_have="${ic_have#v}"
        ic_want="${2#v}"
        ic_have_pre=""
        ic_want_pre=""
        case "$ic_have" in *-*)
            ic_have_pre="${ic_have#*-}"
            ic_have="${ic_have%%-*}"
            ;;
        esac
        case "$ic_want" in *-*)
            ic_want_pre="${ic_want#*-}"
            ic_want="${ic_want%%-*}"
            ;;
        esac
        for ic_part in 1 2 3; do
            ic_h="$(printf '%s' "$ic_have" | cut -d. -f"$ic_part")"
            ic_w="$(printf '%s' "$ic_want" | cut -d. -f"$ic_part")"
            case "$ic_h" in "" | *[!0-9]*) return 1 ;; esac
            case "$ic_w" in "" | *[!0-9]*) return 1 ;; esac
            [ "$ic_h" -gt "$ic_w" ] && return 0
            [ "$ic_h" -lt "$ic_w" ] && return 1
        done
        [ -z "$ic_have_pre" ] || [ "$ic_have_pre" = "$ic_want_pre" ]
    }
    if [ -n "${IC_VERSION:-}" ] && [ -x "$dest" ] && ic_not_older "$dest" "$IC_VERSION"; then
        IC="$dest"
        echo "note: $ic_seen is installed (this run asks for ic ${IC_VERSION} or newer) — not downloading it."
    else
        echo "intentic: fetching the ic CLI…"
        # THE ic THE DESKTOP APP CARRIES, copied instead of downloaded. The app names the ic its installer put beside it
        # (INTENTIC_IC_PATH) and pins the run to its own release (IC_VERSION), so a copy that answers exactly that release
        # is the very binary the download would fetch, minus the network: a machine that cannot reach github.com still
        # gets its ic. Anything else — no pin, no file, another version, a copy that fails — leaves the download to run
        # as it always has, and that download is all the curl|sh one-liner ever does.
        ic_carried() {
            [ -n "${INTENTIC_IC_PATH:-}" ] && [ -n "${IC_VERSION:-}" ] && [ -f "$INTENTIC_IC_PATH" ] &&
                [ "$("$INTENTIC_IC_PATH" --version 2>/dev/null || true)" = "ic ${IC_VERSION#v}" ] &&
                cp "$INTENTIC_IC_PATH" "${dest}.tmp" &&
                echo "note: installed ic ${IC_VERSION#v} from the copy the desktop app carries — not downloading it."
        }
        # Download beside the target and rename into place: overwriting a running executable fails outright
        # ("Text file busy"), and a half-downloaded binary must never be what runs.
        if ic_carried || curl -fsSL "${IC_URL:-https://github.com/intentic/intentic/releases/latest/download}/ic-${os}-${arch}" -o "${dest}.tmp"; then
            chmod +x "${dest}.tmp"
            mv -f "${dest}.tmp" "$dest"
            IC="$dest"
            if [ "$(id -u)" != 0 ]; then
                mkdir -p "$HOME/.local/bin"
                ln -sf "$dest" "$HOME/.local/bin/ic"
            fi
        else
            rm -f "${dest}.tmp"
            IC="$(command -v ic || true)"
            if [ -n "$IC" ]; then
                echo "note: could not download the latest ic CLI — continuing with the installed $IC." >&2
            else
                echo "error: could not download the ic CLI and none is installed — check your network and re-run." >&2
                exit 1
            fi
        fi
    fi
fi

# ---- the one verb ----
# A leading `-` is ic's own flag, not a code (a code is letters, digits and dashes, and never starts with one).
case "${1:-}" in
    "") exec "$IC" sandbox fix ;;
    -*) exec "$IC" sandbox fix "$@" ;;
    *)
        code="$1"
        shift
        exec "$IC" sandbox fix --code "$code" "$@"
        ;;
esac
