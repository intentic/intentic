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
    echo "intentic: fetching the ic CLI…"
    # Download beside the target and rename into place: overwriting a running executable fails outright
    # ("Text file busy"), and a half-downloaded binary must never be what runs.
    if curl -fsSL "${IC_URL:-https://github.com/intentic/intentic/releases/latest/download}/ic-${os}-${arch}" -o "${dest}.tmp"; then
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
