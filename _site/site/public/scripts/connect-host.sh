#!/bin/sh
# intentic connect-host: a bootstrap shim. It gets Docker onto this server, finds or downloads the ic CLI, and hands
# over to `ic machine enroll`, which connects the server: service user and SSH key, this server's own Cloudflare
# tunnel, the POST /enroll self-registration. The flow lives in _sandbox/ic; this file stays the thing a person can read
# before piping it into sh. It does NOT create or recreate a sandbox; that already exists from setup.
#
# Usage (the Infra screen hands you this):
#   curl -fsSL https://intentic.dev/server/<SANDBOX_HOST>/<CODE> | sh
# where CODE is a single-use code the sandbox minted: this script spends it at https://<SANDBOX_HOST>/system/redeem/
# for SANDBOX_URL, CONNECT_TOKEN, ZONE and HOST_NAME, so no token rides the command. The Cloudflare token never does:
# `ic machine enroll` asks for it on the terminal when CF_TOKEN is not set.
#
# The older env-var shapes still work:
#     curl -fsSL https://intentic.dev/connect-host | sudo env SANDBOX_URL=… CONNECT_TOKEN=… CF_TOKEN=… ZONE=… HOST_NAME=… sh
# and a tunnel minted elsewhere can still be handed in directly, skipping the Cloudflare call:
#     curl -fsSL https://intentic.dev/connect-host \
#       | sudo env SANDBOX_URL=… CONNECT_TOKEN=… HOST_SSH_TUNNEL_TOKEN=… HOST_SSH_HOSTNAME=… HOST_NAME=… sh
#
# Connecting a server changes the system (a user, packages, a service), so it needs root. Run without it from the site,
# it says why and runs itself again through sudo, before the code is spent.
#
# The ic binary is downloaded on EVERY run, so re-running the one-liner upgrades an existing install; only a failed
# download falls back to what is installed. IC_BIN overrides for local dev (a checkout's own build).
# POSIX sh (piped into `sh`, which is dash on Debian/Ubuntu/WSL; no `pipefail`).
set -eu

# >>> generated from _site/site/scripts-kit/kit.sh: edit it there, then run node _tools/checks/scripts-kit.mjs --fix
# The shim kit: the protocol's shapes (docs/ops/cli-output-protocol.md) for the few lines a script prints before it
# hands over to ic or intentic-machine, which draw everything after that themselves. POSIX sh: piped into `sh`, which
# is dash on Debian, Ubuntu and WSL.
#
#   kit_begin <what this does> [scope]       the header; rich only, and only in a script that draws a whole flow
#   kit_step <phase> <sentence> <label>      a step; plain prints `intentic: [<phase>] <sentence>` (no phase: narration)
#   kit_say <sentence>                       narration under the running step
#   kit_warn <sentence>                      a caution: degraded, not broken (stderr in plain)
#   kit_suspend / kit_resume                 hand the screen to a command that prints its own lines, and take it back
#   kit_settle                               the running step is done
#   kit_finished <verdict>                   a flow's past-tense verdict
#   kit_stop <headline> [problem] [fix] [code]
#                                            stop: the running step settles as failed, the stop block goes to stderr,
#                                            and the script exits with code (1 unless given; 2 for a wrong command line)
#   kit_need_root <why> <headline> <fix>     run again through sudo when not root (see below)
#   kit_confirm <question> <consequence> <flag>
#                                            [y/N] on the controlling terminal: returns on yes, exits 0 on no, stops when
#                                            nobody is there (INTENTIC_NO_PROMPT=1, no terminal) naming the flag that answers

case "${INTENTIC_UI:-}" in
    rich | plain | nested) kit_mode="$INTENTIC_UI" ;;
    *)
        if [ "${INTENTIC_PLAIN:-}" = 1 ]; then
            kit_mode=plain
        elif [ -t 1 ]; then
            kit_mode=rich
        else
            kit_mode=plain
        fi
        ;;
esac
kit_color=""
if [ "$kit_mode" = rich ] && { [ -n "${FORCE_COLOR:-}" ] || [ -z "${NO_COLOR:-}" ]; }; then
    kit_color=1
fi
# Unicode unless the locale says the console cannot draw it, as ic decides.
case "$(printf '%s' "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" | tr '[:upper:]' '[:lower:]')" in
    "" | *utf-8* | *utf8*)
        kit_ok="✓" kit_fail="✗" kit_skip="·" kit_run="⠹" kit_more="…"
        ;;
    *)
        kit_ok="+" kit_fail="x" kit_skip="-" kit_run="|" kit_more="..."
        ;;
esac
kit_label=""
kit_open=""
kit_started=0
kit_width=""

# kit_paint <sgr> <text>: the text in one SGR style when colour is on, as it is otherwise.
kit_paint() {
    if [ -n "$kit_color" ]; then
        printf '\033[%sm%s\033[0m' "$1" "$2"
    else
        printf '%s' "$2"
    fi
}

kit_columns() {
    if [ -z "$kit_width" ]; then
        kit_width="$( (stty size </dev/tty) 2>/dev/null | cut -d' ' -f2)"
        case "$kit_width" in "" | *[!0-9]*) kit_width=80 ;; esac
        [ "$kit_width" -le 100 ] || kit_width=100
    fi
}

# The running step's line, which stays the last line on the screen until it settles.
kit_draw() {
    printf '  %s  %s%s' "$(kit_paint 36 "$kit_run")" "$kit_label" "$kit_more"
    kit_open=1
}

kit_clear() {
    if [ -n "$kit_open" ]; then
        printf '\r\033[K'
        kit_open=""
    fi
}

# kit_above <line>: a whole line above the live one.
kit_above() {
    was_open="$kit_open"
    kit_clear
    printf '%s\n' "$1"
    [ -z "$was_open" ] || kit_draw
}

# kit_settle [ok|fail|skip]: the running step, settled in place with how long it took.
kit_settle() {
    [ -n "$kit_label" ] || return 0
    if [ "$kit_mode" = rich ]; then
        case "${1:-ok}" in
            fail) glyph="$(kit_paint 31 "$kit_fail")" ;;
            skip) glyph="$(kit_paint 2 "$kit_skip")" ;;
            *) glyph="$(kit_paint 32 "$kit_ok")" ;;
        esac
        took=$(($(date +%s) - kit_started))
        if [ "$took" -ge 60 ]; then
            took="$((took / 60))m"
        elif [ "$took" -ge 1 ]; then
            took="${took}s"
        else
            took=""
        fi
        kit_columns
        kit_clear
        if [ -z "$took" ]; then
            # Under a second: sh has no finer clock, and a row of spaces leading to nothing reads as a missing value.
            printf "  %s  %s\n" "$glyph" "$kit_label"
        else
            pad=$((kit_width - 7 - ${#kit_label} - ${#took}))
            [ "$pad" -ge 2 ] || pad=2
            printf "  %s  %s%${pad}s%s\n" "$glyph" "$kit_label" "" "$(kit_paint 2 "$took")"
        fi
    fi
    kit_label=""
}

kit_begin() {
    [ "$kit_mode" = rich ] || return 0
    printf '\n  %s\n' "$(kit_paint 1 "intentic · $1")"
    [ -z "${2:-}" ] || printf '  %s\n' "$(kit_paint 2 "$2")"
    printf '\n'
}

kit_step() {
    case "$kit_mode" in
        plain)
            if [ -n "$1" ]; then
                printf 'intentic: [%s] %s\n' "$1" "$2"
            else
                printf 'intentic: %s\n' "$2"
            fi
            ;;
        nested) printf '        %s\n' "$3" ;;
        *)
            kit_settle ok
            kit_label="$3"
            kit_started="$(date +%s)"
            kit_draw
            ;;
    esac
}

kit_say() {
    case "$kit_mode" in
        plain) printf 'intentic: %s\n' "$1" ;;
        nested) printf '        %s\n' "$1" ;;
        *) kit_above "        $(kit_paint 2 "$1")" ;;
    esac
}

kit_warn() {
    case "$kit_mode" in
        plain) printf 'intentic: %s\n' "$1" >&2 ;;
        nested) printf '     !  %s\n' "$1" ;;
        *) kit_above "     $(kit_paint 33 !)  $(kit_paint 2 "$1")" ;;
    esac
}

kit_suspend() {
    [ "$kit_mode" = rich ] || return 0
    kit_clear
}

kit_resume() {
    [ "$kit_mode" = rich ] && [ -n "$kit_label" ] && [ -z "$kit_open" ] && kit_draw
    return 0
}

kit_finished() {
    case "$kit_mode" in
        plain) printf 'intentic: %s\n' "$1" ;;
        nested) printf '     %s  %s\n' "$kit_ok" "$1" ;;
        *)
            kit_settle ok
            printf '\n  %s  %s\n\n' "$(kit_paint 32 "$kit_ok")" "$(kit_paint 1 "$1")"
            ;;
    esac
}

kit_stop() {
    if [ "$kit_mode" = plain ]; then
        printf 'error: %s\n' "$1" >&2
        [ -z "${2:-}" ] || printf '   problem: %s\n' "$2" >&2
        [ -z "${3:-}" ] || printf '   fix:     %s\n' "$3" >&2
    else
        kit_settle fail
        {
            printf '\n  %s  %s\n' "$(kit_paint 31 "$kit_fail")" "$(kit_paint 31 "$1")"
            [ -z "${2:-}" ] || printf '     %s%s\n' "$(kit_paint 2 'problem: ')" "$2"
            [ -z "${3:-}" ] || printf '     %s%s\n' "$(kit_paint 2 'fix:     ')" "$3"
            printf '\n'
        } >&2
    fi
    exit "${4:-1}"
}

kit_cancelled() {
    case "$kit_mode" in
        plain) printf 'intentic: Cancelled. Nothing changed.\n' ;;
        *)
            kit_settle skip
            printf '  %s  %s\n' "$(kit_paint 2 "$kit_skip")" "$(kit_paint 2 'Cancelled. Nothing changed.')"
            ;;
    esac
}

# Questions go to the controlling terminal, never stdin, so `curl … | sh` can still ask. The open is the probe, in a
# subshell: `[ -r /dev/tty ]` passes even where opening fails (systemd, cron, setsid).
kit_confirm() {
    if [ "${INTENTIC_NO_PROMPT:-}" != 1 ] && (exec </dev/tty) 2>/dev/null; then
        kit_suspend
        {
            if [ "$kit_mode" = rich ]; then
                printf '  %s  %s\n' "$(kit_paint 36 ?)" "$(kit_paint 1 "$1")"
                [ -z "$2" ] || printf '%s\n' "$2" | while IFS= read -r line; do printf '     %s\n' "$(kit_paint 2 "$line")"; done
                printf '     [y/N] '
            else
                printf '%s\n' "$1"
                [ -z "$2" ] || printf '%s\n' "$2"
                printf '[y/N] '
            fi
        } >/dev/tty
        if read -r kit_answer </dev/tty; then
            case "$kit_answer" in
                y* | Y*)
                    kit_resume
                    return 0
                    ;;
            esac
            kit_cancelled
            exit 0
        fi
    fi
    kit_stop "Nothing was changed." "nobody is at this terminal to answer: $1" "run it again with $3"
}

# kit_need_root <why> <headline> <fix>: elevation, asked for at the step that needs it and never baked into the command.
# Root already: nothing to do. Served by the site's Worker (INTENTIC_SCRIPT_URL, the URL this very script came from):
# say why in one sentence and run the same script again through sudo. Plain `sudo sh`, not `sudo -E`, which many
# sudoers refuse: the URL carries the arguments, and a token the person exported is asked for again on the terminal.
# Otherwise there is no copy to run again, so stop with the fix. Called before anything is spent (a code, a download).
kit_need_root() {
    [ "$(id -u)" != 0 ] || return 0
    if [ -n "${INTENTIC_SCRIPT_URL:-}" ] && command -v sudo >/dev/null 2>&1; then
        kit_say "$1"
        kit_suspend
        exec sh -c 'curl -fsSL "$1" | sudo sh' sh "$INTENTIC_SCRIPT_URL"
    fi
    kit_stop "$2" "it needs administrator rights, and this run is not root." "$3"
}
# <<< end of generated kit.sh

# >>> generated from _site/site/scripts-kit/redeem.sh: edit it there, then run node _tools/checks/scripts-kit.mjs --fix
# kit_redeem <host> <code> <kind>: spend a single-use code at the sandbox that minted it, before anything is downloaded,
# so a dead code fails in a second. The answer is `KEY=value` lines (_sandbox/sandbox/src/peers/redeem-codes.ts), read
# into the very variables a run started from the environment uses: SANDBOX_URL, PAIR_TOKEN, SYNC_DIR, TAKEOVER,
# CONNECT_TOKEN, ZONE, HOST_NAME. Only those keys are taken, and nothing is evaluated.
kit_redeem() {
    case "$1" in
        "" | *[!A-Za-z0-9.-]*) kit_stop "This command is not complete." "$1 is not the address of a sandbox." "get a new command from the card it came from." ;;
    esac
    case "$2" in
        "" | *[!A-Za-z0-9-]*) kit_stop "This code is not valid any more." "" "get a new command from the card it came from." ;;
    esac
    kit_step "" "checking the code with $1…" "Check the code for $1"
    kit_reply="$(curl -s -X POST --max-time 30 -w '\n%{http_code}' "https://$1/system/redeem/$2" 2>/dev/null || true)"
    kit_status="$(printf '%s\n' "$kit_reply" | tail -n 1)"
    kit_body="$(printf '%s\n' "$kit_reply" | sed '$d')"
    case "$kit_status" in
        200) ;;
        404 | 429)
            # One sentence from the sandbox, "<what happened>: <what to do>".
            kit_said="$(printf '%s\n' "$kit_body" | head -n 1)"
            case "$kit_said" in
                *": "*) kit_stop "${kit_said%%: *}." "" "${kit_said#*: }" ;;
                "") kit_stop "This code is not valid any more." "" "get a new command from the card it came from." ;;
                *) kit_stop "$kit_said" "" "get a new command from the card it came from." ;;
            esac
            ;;
        000 | "") kit_stop "The code could not be checked." "$1 did not answer from this device." "check the network, then run the same command again." ;;
        *) kit_stop "The code could not be checked." "$1 answered with HTTP $kit_status." "run the same command again in a minute." ;;
    esac
    kit_kind=""
    while IFS= read -r kit_line; do
        kit_value="${kit_line#*=}"
        case "$kit_line" in
            KIND=*) kit_kind="$kit_value" ;;
            SANDBOX_URL=*) SANDBOX_URL="$kit_value" ;;
            PAIR_TOKEN=*) PAIR_TOKEN="$kit_value" ;;
            SYNC_DIR=*) SYNC_DIR="$kit_value" ;;
            TAKEOVER=*) TAKEOVER="$kit_value" ;;
            CONNECT_TOKEN=*) CONNECT_TOKEN="$kit_value" ;;
            ZONE=*) ZONE="$kit_value" ;;
            HOST_NAME=*) HOST_NAME="$kit_value" ;;
        esac
    done <<KIT_ANSWER
$kit_body
KIT_ANSWER
    if [ "$kit_kind" != "$3" ]; then
        kit_stop "This code belongs to another command." "it connects a ${kit_kind:-different thing}, and this command connects a $3." "get a new command from the card it came from."
    fi
    kit_settle
}
# <<< end of generated redeem.sh

# >>> generated from _site/site/scripts-kit/ic-fetch.sh: edit it there, then run node _tools/checks/scripts-kit.mjs --fix
# ic_fetch: find or download the ic CLI into $IC, unless $IC is already set. IC_BIN overrides (a checkout's own
# build). An unpinned run downloads every time, which is how re-running a one-liner upgrades a device; only a failed
# download falls back to an installed ic. Download beside the target and rename into place: overwriting a running
# executable fails outright ("Text file busy"), and a half-downloaded binary must never be what runs.
ic_fetch() {
    IC="${IC:-${IC_BIN:-}}"
    [ -z "$IC" ] || return 0
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    case "$os" in
        linux | darwin) ;;
        *) kit_stop "ic could not be installed." "this device runs $os, and ic is built for Linux and macOS." "on Windows, use the PowerShell command from the same card." ;;
    esac
    arch="$(uname -m)"
    case "$arch" in
        x86_64 | amd64) arch="amd64" ;;
        arm64 | aarch64) arch="arm64" ;;
        *) kit_stop "ic could not be installed." "this device's processor is $arch, and ic is built for amd64 and arm64." ;;
    esac
    if [ "$(id -u)" = 0 ]; then
        dest="/usr/local/bin/ic"
    else
        dest="$HOME/.intentic/ic/bin/ic"
        mkdir -p "$(dirname "$dest")"
    fi
    # A run pinned to a release (IC_VERSION beside IC_URL, which the desktop app sets to its own) that finds that
    # release OR A NEWER ONE installed has nothing to fetch: asking the binary costs milliseconds. Never "exactly that
    # release": the machine agent moves ic up by itself, so a desktop app left in the tray for days put an older ic
    # back on every Start, Stop or Restart it ran (2026-10-05).
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
        kit_say "$ic_seen is installed, and this run asks for ic ${IC_VERSION#v} or newer, so nothing is downloaded."
    else
        kit_step fetching-ic "fetching the ic CLI…" "Download ic"
        # THE ic THE DESKTOP APP CARRIES, copied instead of downloaded. The app names the ic its installer put beside it
        # (INTENTIC_IC_PATH) and pins the run to its own release (IC_VERSION), so a copy that answers exactly that release
        # is the very binary the download would fetch, minus the network: a device that cannot reach github.com still
        # gets its ic. Anything else (no pin, no file, another version, a copy that fails) leaves the download to run.
        ic_carried() {
            [ -n "${INTENTIC_IC_PATH:-}" ] && [ -n "${IC_VERSION:-}" ] && [ -f "$INTENTIC_IC_PATH" ] &&
                [ "$("$INTENTIC_IC_PATH" --version 2>/dev/null || true)" = "ic ${IC_VERSION#v}" ] &&
                cp "$INTENTIC_IC_PATH" "${dest}.tmp" &&
                kit_say "installed ic ${IC_VERSION#v} from the copy the desktop app carries."
        }
        ic_base="${IC_URL:-https://github.com/intentic/intentic/releases/latest/download}"
        # curl's own sentence would land on the live line; the stop below says the same thing in this page's words.
        if ic_carried || curl -fsL "${ic_base}/ic-${os}-${arch}" -o "${dest}.tmp" 2>/dev/null; then
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
                kit_warn "the newest ic could not be downloaded, so the one installed at $IC runs instead."
            else
                ic_host="${ic_base#*://}"
                kit_stop "ic could not be downloaded, and no copy is installed." "${ic_host%%/*} did not answer from this device." "check the network, then run the same command again."
            fi
        fi
        kit_settle
    fi
}
# <<< end of generated ic-fetch.sh

if [ "$(uname -s)" != Linux ]; then
    kit_stop "This server could not be connected." "it runs $(uname -s), and a server is a Linux machine." "on Windows, use the PowerShell command from the same card."
fi
kit_need_root "Connecting a server adds a user and a service to it, so sudo asks for your password." \
    "This server could not be connected." "run the same command with sudo in front of sh."
if ! command -v curl >/dev/null 2>&1; then
    kit_stop "This server could not be connected." "curl is not installed on this server." "install curl, then run the same command again."
fi

# The Worker's /server/<host>/<code> passes the pair as arguments: the code is spent here, first, so a dead one fails in
# a second, and what it stood for lands in the variables an env-var run sets itself.
if [ $# -ge 2 ]; then
    kit_redeem "$1" "$2" server
    export SANDBOX_URL CONNECT_TOKEN ZONE HOST_NAME
fi

kit_step checking-docker "checking Docker…" "Check Docker"
if ! command -v docker >/dev/null 2>&1; then
    # A server is a standard Linux machine, so Docker Engine comes from Docker's official convenience script, with
    # consent (a system change), pre-given by INSTALL_DOCKER=1 for headless runs.
    if [ "${INSTALL_DOCKER:-}" != 1 ]; then
        kit_confirm "Install Docker Engine?" "Docker is not installed. It comes from get.docker.com and runs what you deploy on this server." \
            "INSTALL_DOCKER=1 set, or install Docker yourself from https://docs.docker.com/engine/install/"
    fi
    kit_step installing-docker "installing Docker Engine (get.docker.com)…" "Install Docker"
    kit_suspend
    curl -fsSL https://get.docker.com | sh
    # Enable on boot and start now: also what brings deployed containers back after a reboot.
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        systemctl enable --now docker >/dev/null 2>&1 || true
    elif command -v service >/dev/null 2>&1; then
        service docker start >/dev/null 2>&1 || true
    fi
    kit_resume
    # A freshly installed daemon takes a moment to come up.
    i=0
    until docker version --format '{{.Server.Version}}' >/dev/null 2>&1; do
        i=$((i + 1))
        if [ "$i" -ge 10 ]; then
            kit_stop "Docker did not start." "its engine did not answer within 20s." "start Docker, then run the same command again."
        fi
        sleep 2
    done
fi
kit_settle

IC=""
ic_fetch
kit_suspend

# The enrolment (user, sshd, tunnel, /enroll) is ic's. The env this shell carries (SANDBOX_URL, CONNECT_TOKEN, CF_TOKEN
# and ZONE or the pre-provisioned tunnel values, HOST_NAME, HOST_USER) rides along.
exec "$IC" machine enroll
