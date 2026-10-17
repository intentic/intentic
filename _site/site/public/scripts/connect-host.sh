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
#   kit_need_root <why> <headline> <fix> [names]
#                                            run again through sudo when not root, keeping the named settings (see below)
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

# kit_need_root <why> <headline> <fix> [names]: elevation, asked for at the step that needs it and never baked into the
# command. Root already: nothing to do. Served by the site's Worker (INTENTIC_SCRIPT_URL, the URL this very script came
# from): say why in one sentence, fetch the same script again into a file, and run that through sudo. The copy carries
# the arguments (the Worker writes them into it). Not `sudo -E`, which many sudoers refuse, and sudo's env_reset drops
# everything else, so `sudo env` hands over by name the settings that are set: the kit's own and the script's [names]
# (consent like INSTALL_DOCKER=1, which a headless fix tells the person to set). Tokens are not among them: a command
# line is what ps and sudo's log show, so a token the person exported is asked for again on the terminal.
# INTENTIC_ELEVATED=1 marks the copy sudo runs; a copy that is still not root stops instead of asking sudo again.
# Otherwise there is no copy to run again, so stop with the fix. Called before anything is spent (a code, a download).
kit_need_root() {
    [ "$(id -u)" != 0 ] || return 0
    if [ "${INTENTIC_ELEVATED:-}" = 1 ]; then
        kit_stop "$2" "sudo ran this script again, and it is still not root." "$3"
    fi
    if [ -n "${INTENTIC_SCRIPT_URL:-}" ] && command -v sudo >/dev/null 2>&1; then
        kit_root_headline="$2"
        kit_root_names="INTENTIC_UI INTENTIC_PLAIN NO_COLOR FORCE_COLOR INTENTIC_NO_PROMPT IC_BIN IC_URL IC_VERSION INTENTIC_IC_PATH ${4:-}"
        kit_say "$1"
        kit_root_copy="$(mktemp 2>/dev/null)" || kit_root_copy=""
        # An empty answer is a failure too: `sudo sh` would read nothing, run nothing, and exit 0.
        if [ -z "$kit_root_copy" ] || ! curl -fsSL "$INTENTIC_SCRIPT_URL" -o "$kit_root_copy" 2>/dev/null || [ ! -s "$kit_root_copy" ]; then
            [ -z "$kit_root_copy" ] || rm -f "$kit_root_copy"
            kit_root_host="${INTENTIC_SCRIPT_URL#*://}"
            kit_stop "$kit_root_headline" "it needs administrator rights, and ${kit_root_host%%/*} did not answer when it was fetched again to run through sudo." "check the network, then run the same command again."
        fi
        set -- INTENTIC_ELEVATED=1
        for kit_root_name in $kit_root_names; do
            eval "[ -z \"\${$kit_root_name+x}\" ] || set -- \"\$@\" \"$kit_root_name=\${$kit_root_name}\""
        done
        kit_suspend
        # `|| …`, not `$?` on the next line: a script under `set -e` would end at a refused password with the copy left.
        kit_root_code=0
        sudo env "$@" sh "$kit_root_copy" || kit_root_code=$?
        rm -f "$kit_root_copy"
        exit "$kit_root_code"
    fi
    kit_stop "$2" "it needs administrator rights, and this run is not root." "$3"
}
# <<< end of generated kit.sh

# >>> generated from _site/site/scripts-kit/redeem.sh: edit it there, then run node _tools/checks/scripts-kit.mjs --fix
# kit_redeem_check <host> <code>: the command's own shape, checked before anything is downloaded, so a mangled one fails
# in a second. The code itself is spent later (below), after the steps that need none of what it stands for.
kit_redeem_check() {
    case "$1" in
        "" | *[!A-Za-z0-9.-]*) kit_stop "This command is not complete." "$1 is not the address of a sandbox." "get a new command from the card it came from." ;;
    esac
    case "$2" in
        "" | *[!A-Za-z0-9-]*) kit_stop "This code is not valid any more." "" "get a new command from the card it came from." ;;
    esac
}

# kit_redeem <host> <code> <kind> [name]: spend a single-use code at the sandbox that minted it. A spent code cannot be
# spent again, so a script redeems it AFTER the steps that need none of what it stands for (a download, a question, a
# token check): one of those failing leaves the code valid, and "run the same command again" stays true. The answer is
# `KEY=value` lines (_sandbox/sandbox/src/peers/redeem-codes.ts), read into the very variables a run started from the
# environment uses: SANDBOX_URL, PAIR_TOKEN, SYNC_DIR, TAKEOVER, CONNECT_TOKEN, ZONE, HOST_NAME, HOST_ID. Only those
# keys are taken, and nothing is evaluated. [name] is the name a server will take if its code was minted without one,
# for the sandbox to answer that name's HOST_ID (the id its tunnel is named for); only a settled name (a-z, 0-9, _) is
# sent.
kit_redeem() {
    kit_redeem_check "$1" "$2"
    kit_step "" "checking the code with $1…" "Check the code for $1"
    kit_query=""
    case "${4:-}" in
        "" | *[!a-z0-9_]*) ;;
        *) kit_query="?name=$4" ;;
    esac
    kit_reply="$(curl -s -X POST --max-time 30 -w '\n%{http_code}' "https://$1/system/redeem/$2$kit_query" 2>/dev/null || true)"
    kit_status="$(printf '%s\n' "$kit_reply" | tail -n 1)"
    # Carriage returns off: a CRLF answer would leave one on every value, and KIND would never match.
    kit_body="$(printf '%s\n' "$kit_reply" | sed '$d' | tr -d '\r')"
    case "$kit_status" in
        200) ;;
        404 | 429)
            # The sandbox answers one sentence, "<what happened>: <what to do>". Anything else (a proxy's or a CDN's HTML
            # page, several lines, a wall of text) is not something to print as a headline.
            kit_said="$kit_body"
            kit_nl='
'
            case "$kit_said" in
                *"<"* | *"$kit_nl"*) kit_said="" ;;
            esac
            [ "${#kit_said}" -le 200 ] || kit_said=""
            case "$kit_said" in
                *": "*) kit_stop "${kit_said%%: *}." "" "${kit_said#*: }" ;;
                "") ;;
                *) kit_stop "$kit_said" "" "get a new command from the card it came from." ;;
            esac
            if [ "$kit_status" = 429 ]; then
                kit_stop "The code could not be checked." "$1 has had too many tries from this device in the last minute." "wait a minute, then run the same command again."
            fi
            kit_stop "This code is not valid any more." "" "get a new command from the card it came from."
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
            HOST_ID=*) HOST_ID="$kit_value" ;;
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
# executable fails outright ("Text file busy"), and a half-downloaded binary must never be what runs. What arrives is
# checked against the release's SHA256SUMS before anything runs it (a mismatch is deleted unrun, and the ic already
# installed stays), then probed by running it before it replaces anything: a 200 can be a captive portal's login page
# or an empty body. IC_SKIP_CHECKSUM=1 installs it unchecked where the check cannot be made at all (no sha256sum or
# shasum, no SHA256SUMS beside IC_URL); it never lets a mismatch through.
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
    fi
    # A minimal server image can lack /usr/local/bin, which would otherwise read as a download that failed.
    mkdir -p "$(dirname "$dest")" 2>/dev/null || true
    # ic_runs <file>: the file is a program (an ELF or Mach-O header first, because a shell handed anything else runs it
    # as a script: a login page, or an empty file that "succeeds" having done nothing) that answers `--version` as ic.
    ic_runs() {
        case "$(od -A n -t x1 -N 4 "$1" 2>/dev/null | tr -d ' \n')" in
            7f454c46 | cffaedfe | cafebabe) ;;
            *) return 1 ;;
        esac
        case "$( ("$1" --version) 2>/dev/null)" in
            "ic "*) return 0 ;;
        esac
        return 1
    }
    # ic_sha256 <file>: its SHA-256 in hex, by sha256sum (Linux) or shasum (macOS); nothing when neither is installed.
    ic_sha256() {
        if command -v sha256sum >/dev/null 2>&1; then
            sha256sum "$1" | cut -d' ' -f1
        elif command -v shasum >/dev/null 2>&1; then
            shasum -a 256 "$1" | cut -d' ' -f1
        fi
    }
    # ic_checked <file> <asset>: the file is the asset the release published, by the SHA256SUMS beside it. Otherwise sets
    # ic_why and ic_fix and fails. The release also signs SHA256SUMS (SHA256SUMS.sig, minisign); checking that here would
    # need minisign on the device, so the sums are taken from the same https origin as the binary and the signature is
    # left to the machine agent, which checks it before it replaces ic or itself.
    ic_checked() {
        ic_sum_got="$(ic_sha256 "$1" || true)"
        if [ -z "$ic_sum_got" ]; then
            if [ "${IC_SKIP_CHECKSUM:-}" = 1 ]; then
                kit_warn "neither sha256sum nor shasum is installed, so ic is installed unchecked (IC_SKIP_CHECKSUM=1)."
                return 0
            fi
            ic_why="neither sha256sum nor shasum is installed, so the download cannot be checked against the release's SHA256SUMS."
            ic_fix="install either one, or run the same command with IC_SKIP_CHECKSUM=1 to install ic unchecked."
            return 1
        fi
        ic_sums="$(curl -fsL "${ic_base}/SHA256SUMS" 2>/dev/null || true)"
        if [ -z "$ic_sums" ]; then
            if [ "${IC_SKIP_CHECKSUM:-}" = 1 ]; then
                kit_warn "${ic_host%%/*} served no SHA256SUMS, so ic is installed unchecked (IC_SKIP_CHECKSUM=1)."
                return 0
            fi
            ic_why="${ic_host%%/*} served ic but not the SHA256SUMS to check it against."
            ic_fix="run the same command again; IC_SKIP_CHECKSUM=1 installs ic unchecked from a server that publishes no SHA256SUMS."
            return 1
        fi
        # The sum listed for the asset; "unlisted" when the file names other ic builds but not this one; nothing when it
        # names no ic at all, which is a release from before its SHA256SUMS covered ic (only the desktop installers).
        ic_sum_want="$(printf '%s\n' "$ic_sums" | awk -v asset="$2" '
            { name = $2; sub(/^\*/, "", name); sub(/^\.\//, "", name) }
            name == asset { want = tolower($1) }
            name ~ /^ic-/ { listed = 1 }
            END { if (want != "") print want; else if (listed) print "unlisted" }')"
        case "$ic_sum_want" in
            "")
                kit_say "this release's SHA256SUMS predates checksums for ic, so the download is not checked."
                return 0
                ;;
            unlisted)
                ic_why="the release's SHA256SUMS lists no $2, so the download cannot be checked."
                ic_fix="run the same command again; if it says the same, report it: the release is missing a checksum."
                return 1
                ;;
        esac
        [ "$ic_sum_got" = "$ic_sum_want" ] && return 0
        ic_why="the downloaded ic is not the one the release published (SHA-256 $ic_sum_got, its SHA256SUMS says $ic_sum_want), so it was deleted without being run."
        ic_fix="run the same command again; if it fails the same way, something between this device and ${ic_host%%/*} is altering the download."
        return 1
    }
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
    if [ -n "${IC_VERSION:-}" ] && ic_runs "$dest" && ic_not_older "$dest" "$IC_VERSION"; then
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
        ic_host="${ic_base#*://}"
        ic_why="${ic_host%%/*} did not answer from this device."
        ic_fix="check the network, then run the same command again."
        ic_refused=""
        ic_arrived=""
        # ic_download <asset> <file>: the asset into <file>, by the .gz copy each release publishes beside it (under half
        # the bytes) where gzip can unpack it, else by the asset itself, which every release from before the copies
        # answers for. What lands is checked against the asset's own line in SHA256SUMS either way.
        ic_download() {
            if command -v gzip >/dev/null 2>&1 && curl -fsL "${ic_base}/$1.gz" -o "$2.gz" 2>/dev/null && gzip -dc "$2.gz" >"$2" 2>/dev/null; then
                rm -f "$2.gz"
                return 0
            fi
            rm -f "$2.gz"
            curl -fsL "${ic_base}/$1" -o "$2" 2>/dev/null
        }
        # curl's own sentence would land on the live line; the stop below says the same thing in this page's words. The
        # carried copy is not checked against SHA256SUMS: it is a file on this device, not a download, and the network
        # the check needs is what the copy is there to do without.
        if ic_carried; then
            ic_arrived=1
        elif ic_download "ic-${os}-${arch}" "${dest}.tmp"; then
            if ic_checked "${dest}.tmp" "ic-${os}-${arch}"; then
                ic_arrived=1
            else
                ic_refused=1
            fi
        fi
        if [ -n "$ic_arrived" ]; then
            chmod +x "${dest}.tmp"
            if ic_runs "${dest}.tmp"; then
                mv -f "${dest}.tmp" "$dest"
                IC="$dest"
                if [ "$(id -u)" != 0 ]; then
                    mkdir -p "$HOME/.local/bin"
                    ln -sf "$dest" "$HOME/.local/bin/ic"
                fi
            else
                ic_why="what downloaded is not a working program: a captive portal, a cut-off download, or the wrong architecture."
            fi
        fi
        if [ -z "$IC" ]; then
            rm -f "${dest}.tmp"
            # The one this script installed before, in its own place (off PATH on macOS), then whatever PATH finds.
            for ic_old in "$dest" "$(command -v ic || true)"; do
                if [ -n "$ic_old" ] && ic_runs "$ic_old"; then
                    IC="$ic_old"
                    break
                fi
            done
            if [ -n "$IC" ] && [ -n "$ic_refused" ]; then
                kit_warn "the newest ic was not installed: $ic_why The one installed at $IC runs instead."
            elif [ -n "$IC" ]; then
                kit_warn "the newest ic could not be downloaded, so the one installed at $IC runs instead."
            elif [ -n "$ic_refused" ]; then
                kit_stop "ic was downloaded but not installed, and no copy is installed." "$ic_why" "$ic_fix"
            else
                kit_stop "ic could not be downloaded, and no copy is installed." "$ic_why" "$ic_fix"
            fi
        fi
        kit_settle
    fi
}
# <<< end of generated ic-fetch.sh

if [ "$(uname -s)" != Linux ]; then
    kit_stop "This server could not be connected." "it runs $(uname -s), and a server is a Linux machine." "on Windows, use the PowerShell command from the same card."
fi
# Through sudo, the settings this script and `ic machine enroll` read keep their values (tokens excepted: see the kit).
kit_need_root "Connecting a server adds a user and a service to it, so sudo asks for your password." \
    "This server could not be connected." "run the same command with sudo in front of sh." \
    "INSTALL_DOCKER SANDBOX_URL ZONE HOST_NAME HOST_USER HOST_SSH_HOSTNAME SANDBOX_IMAGE CLOUDFLARED_VERSION"
if ! command -v curl >/dev/null 2>&1; then
    kit_stop "This server could not be connected." "curl is not installed on this server." "install curl, then run the same command again."
fi

# The Worker's /server/<host>/<code> passes the pair as arguments. A mangled command fails here, in a second; the code
# itself is spent after Docker and ic are in place (below), so a question nobody answers or a download that breaks
# leaves it valid for the same command.
if [ $# -ge 2 ]; then
    kit_redeem_check "$1" "$2"
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

# ic's normalize_host_name, for one line: lowercase, `_` for anything but a-z, 0-9 and `_`, `_` before a leading digit,
# and `self` is `host`.
normalize_host_name() {
    printf '%s\n' "$1" | LC_ALL=C sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | LC_ALL=C tr 'A-Z' 'a-z' |
        LC_ALL=C sed -e 's/[^a-z0-9_]/_/g' -e 's/^[0-9]/_&/' -e 's/^self$/host/'
}

# The name `ic machine enroll` gives this server, settled as it settles it: HOST_NAME, else `hostname`, else `host`.
# Nothing beside a pre-provisioned tunnel and no HOST_NAME, which ic refuses rather than name the server after this
# machine. A code minted without a name answers this name's HOST_ID (below), and holds the server to the name.
host_name_for_code() {
    host_name_settled="$(normalize_host_name "${HOST_NAME:-}")"
    if [ -z "$host_name_settled" ]; then
        if [ -n "${HOST_SSH_TUNNEL_TOKEN:-}" ] && [ -n "${HOST_SSH_HOSTNAME:-}" ]; then
            return 0
        fi
        host_name_settled="$(normalize_host_name "$(hostname 2>/dev/null || true)")"
    fi
    printf '%s' "${host_name_settled:-host}"
}

# What the code stood for lands in the variables an env-var run sets itself. Spent last: past this point a failure is
# ic's to report, and the sudo run above has already happened, so it is spent once.
# HOST_ID is the id this server's tunnel and DNS record are named for, digested by the sandbox from its long-lived
# connect token: the code's CONNECT_TOKEN is a single-use one, new on every run, so the id ic would digest from it is
# new too, and every run would make the server a new tunnel. Only the code's answer sets it (the sudo copy redeems, so
# the settings sudo hands over need not carry it); without one, ic digests the id from CONNECT_TOKEN as before.
unset HOST_ID
if [ $# -ge 2 ]; then
    kit_redeem "$1" "$2" server "$(host_name_for_code)"
    export SANDBOX_URL CONNECT_TOKEN ZONE HOST_NAME
    [ -z "${HOST_ID:-}" ] || export HOST_ID
fi
kit_suspend

# The enrolment (user, sshd, tunnel, /enroll) is ic's. The env this shell carries (SANDBOX_URL, CONNECT_TOKEN, CF_TOKEN
# and ZONE or the pre-provisioned tunnel values, HOST_NAME, HOST_ID, HOST_USER) rides along.
exec "$IC" machine enroll
