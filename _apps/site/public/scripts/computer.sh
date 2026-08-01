#!/bin/sh
# intentic — connect THIS Linux computer to your sandbox, so the agent can work on it: run commands, read and
# write files inside the folders you allow, and see the screen. Runs as YOU (no sudo): it installs into
# ~/.intentic/host and registers a per-user login entry so the computer reconnects after a reboot.
# `intentic-host uninstall` removes it. Nothing is opened on your network — the connection is outbound only.
#
# What the agent may actually do here is decided on the sandbox's capability card, not by this script, and is
# enforced by the agent installed on this machine. Revoking it there cuts this machine off immediately.
#
# Usage (the computer's capability card hands you this):
#   curl -fsSL https://intentic.dev/host | env SANDBOX_URL='https://sandbox-<id>.<zone>' PAIR_TOKEN='<token>' sh
#
# Required env:
#   SANDBOX_URL  your sandbox's public URL (from the card).
#   PAIR_TOKEN   the one-time pairing token from the card (single-use, expires in ~10 min).
# Optional env:
#   AGENT_BIN    run THIS agent command instead of downloading a release — for local dev / dogfooding an
#                unreleased build, e.g. AGENT_BIN="node /path/to/intentic/_apps/host/dist/cli.js".
set -eu

URL="${SANDBOX_URL:-}"
PAIR="${PAIR_TOKEN:-}"
if [ -z "$URL" ] || [ -z "$PAIR" ]; then
    echo "error: SANDBOX_URL and PAIR_TOKEN are required (copy the command from the computer's card in your sandbox)." >&2
    exit 1
fi

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
if [ "$os" != "linux" ]; then
    echo "error: this installer connects Linux computers; '$os' is not supported yet." >&2
    exit 1
fi
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
# re-running the card's command upgrades an existing install rather than pinning the machine to whatever version
# it first connected with. Only a failed download falls back to what's installed, then to npx.
BIN="${AGENT_BIN:-}"
if [ -z "$BIN" ]; then
    dest="${HOME}/.intentic/host/bin/intentic-host"
    mkdir -p "$(dirname "$dest")"
    echo "Downloading the intentic-host agent…"
    # Download beside the target and rename into place: the connection runs FROM $dest, and overwriting a running
    # executable fails outright ("Text file busy"). A rename swaps the directory entry instead, leaving the live
    # process on the old inode until it restarts — and a half-downloaded agent is never what runs.
    if curl -fsSL "https://gitlab.com/api/v4/projects/radarsu%2Fintentic/packages/generic/intentic-host/latest/intentic-host-${os}-${arch}" -o "${dest}.tmp"; then
        chmod +x "${dest}.tmp"
        mv -f "${dest}.tmp" "$dest"
        BIN="$dest"
        # Put `intentic-host` on PATH for the status/uninstall commands the setup output suggests.
        mkdir -p "$HOME/.local/bin"
        ln -sf "$dest" "$HOME/.local/bin/intentic-host"
        case ":$PATH:" in
            *":$HOME/.local/bin:"*) ;;
            *) echo "note: add ~/.local/bin to your PATH to use \`intentic-host\` directly (or run $dest)." ;;
        esac
    else
        rm -f "${dest}.tmp"
        BIN="$(command -v intentic-host || true)"
        if [ -n "$BIN" ]; then
            echo "note: could not download the latest agent — continuing with the installed $BIN." >&2
        elif command -v npx >/dev/null 2>&1; then
            echo "Falling back to npx (@intentic/host@latest)…" >&2
            BIN="npx -y @intentic/host@latest"
        else
            echo "error: could not download the agent and no npx fallback (install Node.js, or see the docs)." >&2
            exit 1
        fi
    fi
fi

# BIN may be "npx -y @intentic/host@latest" (intentional word-split); a real path runs directly.
# shellcheck disable=SC2086
exec $BIN setup --url "$URL" --pair "$PAIR"
