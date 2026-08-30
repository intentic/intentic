#!/bin/sh
# intentic desktop sync — enable desktop sync on THIS machine: two-way sync a local folder with your
# sandbox's /work (block-delta, near-real-time), and mirror the sandbox's dev-server ports onto this machine's
# localhost (both powered by Mutagen). Runs as YOU (no sudo): it installs the one machine agent into
# ~/.intentic/machine (shared with the connected-computer capability, if you enable that too) and registers
# per-user login entries (the agent + the Mutagen daemon) so both resume after a reboot.
# `intentic-machine sync uninstall` removes everything.
#
# THIS IS A BOOTSTRAP SHIM: its whole job is to put a FIRST agent on a machine that has none, then hand over
# to `intentic-machine sync setup`, which decides everything else — including moving an already-installed
# agent onto the current release, so re-running this command still upgrades a machine. The decisions used to
# live here, copied across four scripts in two shell dialects; they now live once, in the agent
# (_computers/machine/src/install.ts), where they are compiled and tested.
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
#   AGENT_BIN    run THIS agent command instead of the installed one — for local dev / dogfooding an
#                unreleased build, e.g. AGENT_BIN="node /path/to/intentic/_computers/machine/dist/cli.js".
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

# ---- bootstrap the agent binary (identical in computer.sh and sync.sh: standalone `curl | sh` files, no shared code) ----
#
# Only when NO working agent is installed: a machine that has one skips straight to `setup`, which asks the
# release channel itself and self-updates first. The download is pinned to the tag `releases/latest` resolves
# to right now (one HEAD, no body, no API rate limit), so an interrupted transfer resumes against the exact
# release it started from, never a splice of two. What lands is probed by running it — `version` answering is
# the only proof the file is a working agent rather than 95 MB of captive-portal login page — and only a
# probed binary is moved into place.
BIN="${AGENT_BIN:-}"
if [ -z "$BIN" ]; then
    dest="${HOME}/.intentic/machine/bin/intentic-machine"

    agent_version() {
        # The subshell keeps the SHELL's own "Bus error" for a truncated binary off the user's screen.
        ("$1" version 2>/dev/null | tr -d '\r\n') 2>/dev/null
    }

    case "$(agent_version "$dest")" in
        [0-9]*.[0-9]*.[0-9]*) ;; # a working agent — whether it updates is `setup`'s decision, not this file's
        *)
            mkdir -p "$(dirname "$dest")"
            releases="https://github.com/intentic/intentic/releases"
            published=""
            latest="$(curl -fsSLI -o /dev/null -w '%{url_effective}' --max-time 20 "${releases}/latest" 2>/dev/null || true)"
            case "$latest" in
                */tag/v[0-9]*) published="${latest##*/tag/v}" ;;
            esac
            if [ -n "$published" ]; then
                url="${releases}/download/v${published}/intentic-machine-${os}-${arch}"
                part="${dest}.part-${published}"
            else
                url="${releases}/latest/download/intentic-machine-${os}-${arch}"
                part="${dest}.part"
            fi
            # A partial from another release is bytes that can never be finished.
            for stale in "${dest}".part*; do
                [ "$stale" = "$part" ] || rm -f "$stale"
            done
            echo "Downloading the intentic machine agent${published:+ }${published}…"
            # curl's own bar only where a person is watching; a pipe (the desktop app, `ic`) gets silence and
            # the phase line above.
            meter="--silent"
            if [ -t 2 ] && [ -z "${INTENTIC_PLAIN:-}" ] && [ "${INTENTIC_UI:-}" != "plain" ]; then
                meter="--progress-bar"
            fi
            # shellcheck disable=SC2086 — $meter is one deliberate word, chosen just above.
            if ! curl --fail --location --show-error $meter --retry 3 --retry-delay 2 --continue-at - \
                --output "$part" "$url"; then
                echo "error: the download didn't finish — what did arrive is kept, so re-running this command resumes it." >&2
                exit 1
            fi
            chmod +x "$part"
            case "$(agent_version "$part")" in
                [0-9]*.[0-9]*.[0-9]*) ;;
                *)
                    rm -f "$part"
                    echo "error: what downloaded isn't a working agent (a captive portal, a truncated body, or the wrong architecture) — re-run this command to try again." >&2
                    exit 1
                    ;;
            esac
            # Rename into place: overwriting a running executable fails outright ("Text file busy"); a rename
            # swaps the directory entry and leaves any live process on the old inode until it restarts.
            mv -f "$part" "$dest"
            ;;
    esac
    BIN="$dest"
fi
# ---- end of the agent binary bootstrap ----

set -- sync setup --url "$URL" --pair "$PAIR"
[ -n "$DIR" ] && set -- "$@" --dir "$DIR"
[ -n "${TAKEOVER:-}" ] && set -- "$@" --takeover
# BIN may be a multi-word AGENT_BIN dev command (intentional word-split); a real path runs directly.
# shellcheck disable=SC2086
exec $BIN "$@"
