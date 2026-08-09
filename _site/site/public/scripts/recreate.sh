#!/bin/sh
# intentic recreate — bootstrap shim. The flow itself (update/rebuild/rollback/dev, env replay, overlay
# re-base, the run command the image emits) lives in the `ic` CLI (_sandbox/ic); this script only fetches the
# binary and forwards the argument shapes every one-liner the platform ever handed out:
#
#   curl -fsSL https://intentic.dev/rebuild | sh -s -- <SLUG> <SHA256>   # rebuild: the owner-approved overlay
#   curl -fsSL https://intentic.dev/update  | sh -s -- <SLUG>            # update: the fresh :stable base
#   sh recreate.sh <SLUG> --channel <tag>                                # move onto a release channel
#   sh recreate.sh <SLUG> --rollback                                     # back to the previous image
#   sh recreate.sh --dev [SLUG]                                          # dev: the locally-built dev image
#
# The binary is downloaded on EVERY run, so re-running a card's command upgrades an existing install; only a
# failed download falls back to what's installed. IC_BIN overrides for local dev (a checkout's own build).
# POSIX sh (piped into `sh`, which is dash on Debian/Ubuntu/WSL — no `pipefail`).
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
# CANNOT be shared with _tools/scripts/repo-root.sh: this file is downloaded and run on its own.
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

# ---- map the historical argument shapes onto ic verbs ----
# Mode by argument shape, so every pasted one-liner keeps working: the Environment card's rebuild command
# passes <slug> <sha256>, the Sandbox card's update command passes <slug> alone. The flags are
# distinguishable from a hash by their leading `--` (a sha256 is 64 hex chars and can never start that way).
case "${1:-}" in
    --dev)
        shift
        exec "$IC" sandbox dev "$@"
        ;;
    "")
        exec "$IC" sandbox update
        ;;
    *)
        slug="$1"
        shift
        case "${1:-}" in
            "") exec "$IC" sandbox update "$slug" ;;
            --rollback) exec "$IC" sandbox rollback "$slug" ;;
            --channel)
                shift
                exec "$IC" sandbox update "$slug" --channel "${1:?--channel needs a tag, e.g. --channel stable}"
                ;;
            --*)
                echo "error: unknown option ${1}" >&2
                exit 1
                ;;
            *) exec "$IC" sandbox rebuild "$slug" "$1" ;;
        esac
        ;;
esac
