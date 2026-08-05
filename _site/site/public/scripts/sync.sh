#!/bin/sh
# intentic desktop sync — install the sync agent on THIS machine, two-way sync a local folder with your
# sandbox's /work (block-delta, near-real-time), and mirror the sandbox's dev-server ports onto this machine's
# localhost (both powered by Mutagen). Runs as YOU (no sudo): it installs into ~/.intentic/sync and registers
# per-user login agents (the Mutagen daemon + the port-mirror watcher) so both resume after a reboot.
# `intentic-sync uninstall` removes everything.
#
# Usage (the platform's Desktop sync card hands you this):
#   curl -fsSL https://intentic.dev/sync | env SANDBOX_URL='https://sandbox-<id>.<zone>' PAIR_TOKEN='<token>' SYNC_DIR="$HOME/intentic/<name>-<id>" sh
#
# Required env:
#   SANDBOX_URL  your sandbox's public URL (from the card).
#   PAIR_TOKEN   the one-time pairing token from the card (single-use, expires in ~10 min).
# Optional env:
#   SYNC_DIR     local folder to sync (default: ~/intentic/<id>, the same id the sandbox's own URL carries)
#   TAKEOVER     any non-empty value takes over sync from another machine already enrolled on this sandbox.
#   AGENT_BIN    run THIS agent command instead of downloading a release — for local dev / dogfooding an
#                unreleased build, e.g. AGENT_BIN="node /path/to/intentic/_sandbox/sync/dist/cli.js".
set -eu

URL="${SANDBOX_URL:-}"
PAIR="${PAIR_TOKEN:-}"
DIR="${SYNC_DIR:-}"
if [ -z "$URL" ] || [ -z "$PAIR" ]; then
    echo "error: SANDBOX_URL and PAIR_TOKEN are required (copy the command from the Desktop sync card)." >&2
    exit 1
fi

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in
    linux | darwin) ;;
    *)
        echo "error: unsupported OS '$os' — see the docs for manual setup." >&2
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

# Resolve the agent: an explicit AGENT_BIN (local dev), else the published binary — downloaded on EVERY run, so
# re-running the card's command upgrades an existing install. Short-circuiting on an installed `intentic-sync`
# pinned a machine to the version it first paired with — via the very symlink this script creates — and agent
# fixes could never reach anyone already syncing (the ignore rules that decide whether a project's .git travels
# to the sandbox among them). Only a failed download falls back to what's installed, then to npx.
BIN="${AGENT_BIN:-}"
if [ -z "$BIN" ]; then
    dest="${HOME}/.intentic/sync/bin/intentic-sync"
    mkdir -p "$(dirname "$dest")"
    echo "Downloading the intentic-sync agent…"
    # Download beside the target and rename into place: the mirror watcher runs FROM $dest, and overwriting a
    # running executable fails outright ("Text file busy"). A rename swaps the directory entry instead, leaving
    # the live process on the old inode until it next restarts. It also means a half-downloaded agent is never
    # what runs. The download error stays visible (a masked network/permission failure used to silently drop to npx).
    if curl -fsSL "https://github.com/intentic/intentic/releases/latest/download/intentic-sync-${os}-${arch}" -o "${dest}.tmp"; then
        chmod +x "${dest}.tmp"
        mv -f "${dest}.tmp" "$dest"
        BIN="$dest"
        # Put `intentic-sync` on PATH for the status/pause/resume commands the setup output suggests.
        mkdir -p "$HOME/.local/bin"
        ln -sf "$dest" "$HOME/.local/bin/intentic-sync"
        case ":$PATH:" in
            *":$HOME/.local/bin:"*) ;;
            *) echo "note: add ~/.local/bin to your PATH to use \`intentic-sync\` directly (or run $dest)." ;;
        esac
    else
        rm -f "${dest}.tmp"
        BIN="$(command -v intentic-sync || true)"
        if [ -n "$BIN" ]; then
            echo "note: could not download the latest agent — continuing with the installed $BIN." >&2
        elif command -v npx >/dev/null 2>&1; then
            echo "Falling back to npx (@intentic/sync@latest)…" >&2
            BIN="npx -y @intentic/sync@latest"
        else
            echo "error: could not download the agent and no npx fallback (install Node.js, or see the docs)." >&2
            exit 1
        fi
    fi
fi

set -- setup --url "$URL" --pair "$PAIR"
[ -n "$DIR" ] && set -- "$@" --dir "$DIR"
[ -n "${TAKEOVER:-}" ] && set -- "$@" --takeover
# BIN may be "npx -y @intentic/sync@latest" (intentional word-split); a real path runs directly.
# shellcheck disable=SC2086
exec $BIN "$@"
