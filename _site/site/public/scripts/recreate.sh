#!/bin/sh
# intentic recreate — bootstrap shim. The flow itself (update/rebuild/rollback/dev, env replay, overlay
# re-base, the run command the image emits) lives in the `ic` CLI (_sandbox/ic); this script only fetches the
# binary and forwards the argument shapes every one-liner the platform ever handed out:
#
#   curl -fsSL https://intentic.dev/rebuild | sh -s -- <SLUG> <SHA256>   # rebuild: the owner-approved overlay
#   curl -fsSL https://intentic.dev/update  | sh -s -- <SLUG>            # update: the fresh :stable base
#   sh recreate.sh <SLUG> --prepare                                      # download the next update, apply later
#   sh recreate.sh <SLUG> --channel <tag>                                # move onto a release channel
#   sh recreate.sh <SLUG> --rollback                                     # back to the previous image
#   sh recreate.sh <SLUG> --rollback-to <version|image>                  # back to an older version kept here
#   sh recreate.sh <SLUG> --versions                                     # the versions it can go back to
#   sh recreate.sh <SLUG> --reshape --memory 12g --cpus 4 …              # same image, a different share of the machine
#   sh recreate.sh <SLUG> --shape --memory 12g … --when next-restart      # a shape now, or for the next restart
#   sh recreate.sh <SLUG> --start|--stop|--restart                       # power, applying a saved shape
#   sh recreate.sh <SLUG> --watch                                        # finish a cut-off swap, judge a new version
#   sh recreate.sh <SLUG> --backup                                       # back its data up now
#   sh recreate.sh <SLUG> --doctor                                       # what stands between you and it, and the fix
#   sh recreate.sh <SLUG> --remove                                       # to the trash: recoverable for a week
#   sh recreate.sh --list                                                 # every sandbox here, as JSON
#   sh recreate.sh --dev [SLUG]                                          # dev: the locally-built dev image
#
# The binary is downloaded on EVERY run, so re-running a card's command upgrades an existing install; only a
# failed download falls back to what's installed. IC_BIN overrides for local dev (a checkout's own build).
# A run the desktop app pins to its release copies the ic the app carries (INTENTIC_IC_PATH) instead, when that one
# is exactly the release asked for.
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

# ---- map the historical argument shapes onto ic verbs ----
# Mode by argument shape, so every pasted one-liner keeps working: the Environment card's rebuild command
# passes <slug> <sha256>, the Sandbox card's update command passes <slug> alone. The flags are
# distinguishable from a hash by their leading `--` (a sha256 is 64 hex chars and can never start that way).
case "${1:-}" in
    --dev)
        shift
        exec "$IC" sandbox dev "$@"
        ;;
    # The desktop app's listing when the ic on this machine is older than the app: this fetch brings it level.
    --list) exec "$IC" sandbox list --json ;;
    "")
        exec "$IC" sandbox update
        ;;
    *)
        slug="$1"
        shift
        case "${1:-}" in
            "") exec "$IC" sandbox update "$slug" ;;
            --rollback) exec "$IC" sandbox rollback "$slug" ;;
            # An older version than the one before the last update, among those this machine kept (--versions).
            --rollback-to)
                shift
                exec "$IC" sandbox rollback "$slug" --to "${1:?--rollback-to needs a version or an image, e.g. --rollback-to 1.200.0}"
                ;;
            # ic's own flags (--json) forwarded verbatim, as for --reshape: these two also answer programs.
            --versions | --watch)
                verb="${1#--}"
                shift
                exec "$IC" sandbox "$verb" "$slug" "$@"
                ;;
            --backup | --doctor) exec "$IC" sandbox "${1#--}" "$slug" ;;
            # Into ic's trash, never deleted on the spot: /work and /history stay recoverable for a week
            # (`ic sandbox restore`). -y because whoever runs this has already been asked (the desktop app's Remove).
            --remove) exec "$IC" sandbox remove "$slug" -y ;;
            # Download and build the next update without applying it — the sandbox keeps running, and the
            # update that follows is a restart rather than a wait.
            --prepare) exec "$IC" sandbox prepare "$slug" ;;
            # Everything after --reshape is ic's own flag surface (--memory, --cpus, --privileged, --gpus),
            # forwarded verbatim: the desktop app builds this shape, and ic is where it is validated.
            --reshape)
                shift
                exec "$IC" sandbox reshape "$slug" "$@"
                ;;
            # ic's own `shape` surface (the four fields and --when, or --forget), forwarded verbatim like --reshape.
            --shape)
                shift
                exec "$IC" sandbox shape "$slug" "$@"
                ;;
            # Power through ic, so a start or restart applies the shape saved for the next restart.
            --start | --stop | --restart) exec "$IC" sandbox "${1#--}" "$slug" ;;
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
