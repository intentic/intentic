#!/bin/sh
# intentic desktop sync — install the sync agent on THIS machine, two-way sync a local folder with your
# sandbox's /work (block-delta, near-real-time), and mirror the sandbox's dev-server ports onto this machine's
# localhost (both powered by Mutagen). Runs as YOU (no sudo): it installs into ~/.intentic/sync and registers
# per-user login agents (the Mutagen daemon + the port-mirror watcher) so both resume after a reboot.
# `intentic-sync uninstall` removes everything.
#
# Usage (the platform's Desktop sync card hands you this):
#   curl -fsSL https://intentic.dev/sync | env SANDBOX_URL='https://sandbox-<id>.<zone>' PAIR_TOKEN='<token>' SYNC_DIR="$HOME/intentic/<name>" sh
#
# Required env:
#   SANDBOX_URL  your sandbox's public URL (from the card).
#   PAIR_TOKEN   the one-time pairing token from the card (single-use, expires in ~10 min).
# Optional env:
#   SYNC_DIR     local folder to sync (default: ~/intentic/<sandbox-host>)
#   TAKEOVER     any non-empty value takes over sync from another machine already enrolled on this sandbox.
#   AGENT_BIN    run THIS agent command instead of downloading a release — for local dev / dogfooding an
#                unreleased build, e.g. AGENT_BIN="node /path/to/intentic/_apps/sync/dist/cli.js".
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

# Resolve the agent: an explicit AGENT_BIN (local dev), else an installed `intentic-sync`, else the released
# binary, else npx (when Node is present).
BIN="${AGENT_BIN:-$(command -v intentic-sync || true)}"
if [ -z "$BIN" ]; then
    dest="${HOME}/.intentic/sync/bin/intentic-sync"
    mkdir -p "$(dirname "$dest")"
    echo "Downloading the intentic-sync agent…"
    # The download error stays visible (a masked network/permission failure used to silently drop to npx);
    # a partial file is removed before falling back.
    if curl -fsSL "https://gitlab.com/radarsu/intentic/-/releases/permalink/latest/downloads/bin/intentic-sync-${os}-${arch}" -o "$dest"; then
        chmod +x "$dest"
        BIN="$dest"
        # Put `intentic-sync` on PATH for the status/pause/resume commands the setup output suggests.
        mkdir -p "$HOME/.local/bin"
        ln -sf "$dest" "$HOME/.local/bin/intentic-sync"
        case ":$PATH:" in
            *":$HOME/.local/bin:"*) ;;
            *) echo "note: add ~/.local/bin to your PATH to use \`intentic-sync\` directly (or run $dest)." ;;
        esac
    elif command -v npx >/dev/null 2>&1; then
        rm -f "$dest"
        echo "Falling back to npx (@intentic/sync@latest)…" >&2
        BIN="npx -y @intentic/sync@latest"
    else
        rm -f "$dest"
        echo "error: could not download the agent and no npx fallback (install Node.js, or see the docs)." >&2
        exit 1
    fi
fi

set -- setup --url "$URL" --pair "$PAIR"
[ -n "$DIR" ] && set -- "$@" --dir "$DIR"
[ -n "${TAKEOVER:-}" ] && set -- "$@" --takeover
# BIN may be "npx -y @intentic/sync@latest" (intentional word-split); a real path runs directly.
# shellcheck disable=SC2086
exec $BIN "$@"
