#!/bin/sh
# intentic desktop sync — enable desktop sync on THIS machine: two-way sync a local folder with your
# sandbox's /work (block-delta, near-real-time), and mirror the sandbox's dev-server ports onto this machine's
# localhost (both powered by Mutagen). Runs as YOU (no sudo): it installs the one machine agent into
# ~/.intentic/machine (shared with the connected-computer capability, if you enable that too) and registers
# per-user login entries (the agent + the Mutagen daemon) so both resume after a reboot.
# `intentic-machine sync uninstall` removes everything.
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
#                unreleased build, e.g. AGENT_BIN="node /path/to/intentic/_computers/machine/dist/cli.js".
#   FORCE_DOWNLOAD  any non-empty value re-downloads the agent even when this machine is already on the
#                published build (the download is otherwise skipped, see below).
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

# ---- the agent binary (identical in computer.sh and sync.sh: standalone `curl | sh` files, no shared code) ----
#
# AGENT_BIN (local dev) short-circuits all of this. Otherwise this machine gets the PUBLISHED agent, and the
# first question is whether it already has it. Re-running the card's command is how a machine is UPGRADED, so
# this used to fetch ~95 MB on EVERY run — silently, with no progress, no resume, and no way to tell the fifth
# run of an afternoon from the first. On a home connection that is minutes; on a flaky one it is minutes that
# end in nothing, because a dropped transfer threw away every byte it had.
#
# Two cheap questions answer it instead. What does the agent already here say it is (`version` — which is also
# the only proof that the file is a working binary of a known build rather than something that merely exists)?
# And what does GitHub publish right now (one HEAD that transfers no body: `releases/latest` redirects to
# `…/tag/vX.Y.Z`, and unlike the API that answer carries no per-IP rate limit for an office to share)? Same
# answer, nothing to download. Different answers — or no agent here at all — and it downloads exactly as before,
# so re-running the card's command still upgrades a machine. It just stops paying for an upgrade there is none of.
#
# What this must never become again is a short-circuit on the mere PRESENCE of an agent: that pinned every
# machine to the version it first paired with — through the very symlink this script creates — and agent fixes
# stopped reaching anyone already enrolled, the ignore rules that decide whether a project's .git travels to the
# sandbox among them. "Skip" here means "already the published build", never "something is installed".
BIN="${AGENT_BIN:-}"
if [ -z "$BIN" ]; then
    releases="https://github.com/intentic/intentic/releases"
    dest="${HOME}/.intentic/machine/bin/intentic-machine"
    mkdir -p "$(dirname "$dest")"

    # WHAT A BINARY SAYS IT IS, or nothing at all. Asking is the only proof that a file is a working agent of a
    # known build rather than 95 MB of captive-portal login page, a truncated body, or a binary for another
    # architecture — and a bun-compiled agent carries its bundle at the END of the file, so a partial one cannot
    # answer at all: it dies on the spot. That is why the run sits inside a subshell whose own stderr goes
    # nowhere. The SHELL, not the binary, prints "Bus error" for a signalled child, and that is not the user's news.
    agent_version() {
        ("$1" version 2>/dev/null | tr -d '\r\n') 2>/dev/null
    }

    # …and whether that answer is the release this run is installing. Unresolvable version (GitHub unreachable
    # for the HEAD below): any agent that can state a version is accepted, which is the old behaviour exactly.
    is_the_agent() {
        [ -s "$1" ] || return 1
        chmod +x "$1" || return 1
        claimed="$(agent_version "$1")"
        if [ -n "$published" ]; then
            [ "$claimed" = "$published" ]
        else
            case "$claimed" in
                [0-9]*.[0-9]*.[0-9]*) return 0 ;;
                *) return 1 ;;
            esac
        fi
    }

    installed=""
    if [ -x "$dest" ]; then
        installed="$(agent_version "$dest")"
    fi
    case "$installed" in
        [0-9]*.[0-9]*.[0-9]*) ;;
        *) installed="" ;;
    esac

    published=""
    latest="$(curl -fsSLI -o /dev/null -w '%{url_effective}' --max-time 20 "${releases}/latest" 2>/dev/null || true)"
    case "$latest" in
        */tag/v[0-9]*) published="${latest##*/tag/v}" ;;
    esac

    if [ -n "$installed" ] && [ "$installed" = "$published" ] && [ -z "${FORCE_DOWNLOAD:-}" ]; then
        echo "The intentic machine agent is already the published build (${installed}) — nothing to download."
        BIN="$dest"
    else
        # PINNED TO THE TAG, not to `latest`, and that is what makes resuming safe: a partial can only ever be
        # continued against the exact release it started from, never spliced together out of two. Without a
        # resolved version there is nothing to pin to, so that run falls back to `latest` and starts clean.
        asset="intentic-machine-${os}-${arch}"
        if [ -n "$published" ]; then
            url="${releases}/download/v${published}/${asset}"
            part="${dest}.part-${published}"
        else
            url="${releases}/latest/download/${asset}"
            part="${dest}.part"
        fi
        # A partial from another release is bytes that can never be finished — and they are ~95 MB of them.
        for stale in "${dest}".part*; do
            if [ "$stale" != "$part" ]; then
                rm -f "$stale"
            fi
        done

        # A partial that is in fact COMPLETE: an earlier run got every byte and was killed before it could swap
        # the file in. Nothing to request — and asking first is also what keeps a range starting past the end of
        # a finished file from answering 416 across the user's screen.
        agent=""
        if is_the_agent "$part"; then
            agent="$part"
            echo "An earlier run had already downloaded the whole agent${published:+ }${published} — installing that."
        fi

        if [ -z "$agent" ]; then
            have=0
            if [ -f "$part" ]; then
                have="$(wc -c <"$part" | tr -d '[:space:]')"
            fi
            if [ "$have" -gt 0 ]; then
                echo "Resuming the download of the intentic machine agent${published:+ }${published} — $((have / 1048576)) MB of it is already here…"
            else
                echo "Downloading the intentic machine agent${published:+ }${published}…"
            fi
            # curl's own bar, and only where a person can see it: stderr is a terminal when somebody pasted the
            # one-liner, and a pipe when the desktop app or `ic` is running this inside its own progress display,
            # where a bar's carriage returns are noise in a log file rather than feedback.
            meter="--silent"
            if [ -t 2 ] && [ -z "${INTENTIC_PLAIN:-}" ] && [ "${INTENTIC_UI:-}" != "plain" ]; then
                meter="--progress-bar"
            fi

            attempts=0
            while [ "$attempts" -lt 2 ] && [ -z "$agent" ]; do
                attempts=$((attempts + 1))
                code=0
                # shellcheck disable=SC2086 — $meter is one deliberate word, chosen just above.
                curl --fail --location --show-error $meter --retry 3 --retry-delay 2 --continue-at - \
                    --output "$part" "$url" || code=$?
                if is_the_agent "$part"; then
                    agent="$part"
                elif [ "$code" = 0 ]; then
                    # The transfer FINISHED and what landed is still not this release: those bytes are not
                    # progress, they are wrong, and resuming onto them could only ever produce this again. One
                    # clean attempt from the start, then the ladder below.
                    rm -f "$part"
                    if [ "$attempts" -lt 2 ]; then
                        echo "note: what downloaded isn't a working agent — trying once more from the start." >&2
                    fi
                else
                    # A transfer that did NOT finish: a dropped connection, a timeout, a 5xx, a 404. Whatever
                    # arrived stays exactly where it is — it is progress, and the next run continues from it
                    # rather than starting the 95 MB over.
                    break
                fi
            done
        fi

        if [ -n "$agent" ]; then
            # Rename into place: the connection runs FROM $dest, and overwriting a running executable fails
            # outright ("Text file busy"). A rename swaps the directory entry instead, leaving the live process
            # on the old inode until it restarts — and a half-downloaded agent is never what runs.
            mv -f "$agent" "$dest"
            BIN="$dest"
        elif [ -n "$installed" ]; then
            BIN="$dest"
            echo "note: could not download the current agent — continuing with the ${installed} already installed here." >&2
            if [ -f "$part" ]; then
                echo "note: the part that did arrive is kept — re-running this command picks the download up from there." >&2
            fi
        else
            BIN="$(command -v intentic-machine || true)"
            if [ -n "$BIN" ]; then
                echo "note: could not download the latest agent — continuing with the installed $BIN." >&2
            elif command -v npx >/dev/null 2>&1; then
                echo "Falling back to npx (@intentic/machine@latest)…" >&2
                BIN="npx -y @intentic/machine@latest"
            else
                echo "error: could not download the agent and no npx fallback (install Node.js, or see the docs)." >&2
                exit 1
            fi
        fi
    fi

    # `intentic-machine` on PATH for the status/uninstall commands the setup output suggests — repaired on every
    # run, including the ones that download nothing, since that is now most of them.
    if [ "$BIN" = "$dest" ]; then
        mkdir -p "$HOME/.local/bin"
        ln -sf "$dest" "$HOME/.local/bin/intentic-machine"
        case ":$PATH:" in
            *":$HOME/.local/bin:"*) ;;
            *) echo "note: add ~/.local/bin to your PATH to use \`intentic-machine\` directly (or run $dest)." ;;
        esac
    fi
fi
# ---- end of the agent binary block ----

set -- sync setup --url "$URL" --pair "$PAIR"
[ -n "$DIR" ] && set -- "$@" --dir "$DIR"
[ -n "${TAKEOVER:-}" ] && set -- "$@" --takeover
# BIN may be "npx -y @intentic/machine@latest" (intentional word-split); a real path runs directly.
# shellcheck disable=SC2086
exec $BIN "$@"
