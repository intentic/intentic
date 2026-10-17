#!/bin/sh
# intentic desktop sync: sync a local folder on THIS device two ways with your sandbox's /work (block-delta, near
# real time), and mirror the sandbox's dev-server ports onto this device's localhost (both powered by Mutagen). Runs as
# YOU (no sudo): it installs the one device agent into ~/.intentic/machine (shared with the connected-device capability,
# if you enable that too) and registers per-user login entries (the agent and the Mutagen daemon) so both resume after a
# reboot. `intentic-machine sync uninstall` removes everything.
#
# THIS IS A BOOTSTRAP SHIM: its whole job is to put an agent that understands `sync setup` on a device that has none,
# then hand over to it, and that agent decides everything else, including moving itself onto the current release, so
# re-running this command still upgrades a device. The decisions live once, in the agent
# (_devices/machine/src/install.ts), where they are compiled and tested.
#
# Usage (the platform's Desktop sync card hands you this):
#   curl -fsSL https://intentic.dev/sync/<SANDBOX_HOST>/<CODE> | sh
# where CODE is a single-use code the sandbox minted: this script spends it at https://<SANDBOX_HOST>/system/redeem/
# for SANDBOX_URL, PAIR_TOKEN, and SYNC_DIR and TAKEOVER when the card set them, so no token rides the command. The older
# env-var shape (SANDBOX_URL and PAIR_TOKEN set) still works.
#
# Optional env:
#   SYNC_DIR     local folder to sync (default: ~/intentic/<id>, the same id the sandbox's own URL carries)
#   SYNC_REMOTE_DIR  the sandbox folder it syncs with: /work (the default), or /work/<name> for a project folder of
#                your own, which also needs SYNC_PROJECT.
#   SYNC_PROJECT any non-empty value (the desktop app sends 1): SYNC_DIR is your own project, synced into
#                SYNC_REMOTE_DIR with no sandbox state backup and no git bridge writing into it.
#   SYNC_PROJECTS_HOST  any non-empty value (the desktop app sends 1, through `ic`): pair this device's own sandbox with
#                no folder at all, so folders can attach to it later (`intentic-machine sync attach`). Takes none of
#                SYNC_DIR, SYNC_REMOTE_DIR and SYNC_PROJECT.
#   TAKEOVER     any non-empty value takes over sync from another device already connected to this sandbox.
#   AGENT_BIN    run THIS agent command instead of the installed one: for local dev / dogfooding an unreleased build,
#                e.g. AGENT_BIN="node /path/to/intentic/_devices/machine/dist/cli.js".
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

# >>> generated from _site/site/scripts-kit/agent-fetch.sh: edit it there, then run node _tools/checks/scripts-kit.mjs --fix
# ---- bootstrap the agent binary (identical in device.sh and sync.sh: generated from one source) ----
#
# Only when this device has no agent that can take the handover: one that can skips straight to `setup`, which asks
# the release channel itself and self-updates first. "Can" is asked by RUNNING the handover's own help, never by
# comparing versions: an agent that answers `version` can still be older than the words this script speaks to it, and
# then it is the `setup` that would have updated it that it cannot understand. That is what renaming the `computer`
# route to `device` did: every device paired before the rename answered the card's own command with "No command
# registered for `device`", with no route back to the self-update.
#
# The download is pinned to the tag `releases/latest` resolves to right now (one HEAD, no body, no API rate limit), so
# an interrupted transfer resumes against the exact release it started from, never a splice of two. What lands is
# probed by running it (`version` answering is the only proof the file is a working agent rather than 95 MB of
# captive-portal login page) and only a probed binary is moved into place.
#
# Inputs from the embedding script: $ROUTE (device or sync), $SPEAKS (the handover's flags newer than the route, or
# empty), $os and $arch. Output: $BIN.

agent_version() {
    # The subshell keeps the SHELL's own "Bus error" for a truncated binary off the screen.
    ("$1" version 2>/dev/null | tr -d '\r\n') 2>/dev/null
}

# Does the agent at $1 understand the handover? `<route> setup --help` prints a usage screen and exits 0 on an agent
# that has the route, non-zero on one that does not, and connects nothing either way. Every flag in $3 has to be on that
# screen too: an agent older than one of them refuses the whole handover over it ("No flag registered").
agent_speaks() {
    help="$( ("$1" "$2" setup --help) 2>/dev/null)" || return 1
    # shellcheck disable=SC2086 # $3 is a list of flags, split on purpose.
    for flag in $3; do
        case "$help" in
            *"$flag"*) ;;
            *) return 1 ;;
        esac
    done
}

agent_fetch() {
    BIN="${AGENT_BIN:-}"
    [ -z "$BIN" ] || return 0
    dest="${HOME}/.intentic/machine/bin/intentic-machine"
    have="$(agent_version "$dest")"
    usable=no
    case "$have" in
        [0-9]*.[0-9]*.[0-9]*)
            if agent_speaks "$dest" "$ROUTE" "${SPEAKS:-}"; then
                usable=yes # whether it also UPDATES is `setup`'s decision, not this file's
            else
                kit_say "intentic-machine $have on this device cannot take this handover, so a newer one replaces it."
            fi
            ;;
    esac
    if [ "$usable" = no ]; then
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
        # A partial from another release is bytes that can never be finished; this release's, either kind, is resumed.
        for stale in "${dest}".part*; do
            [ "$stale" = "$part" ] || [ "$stale" = "${part}.gz" ] || rm -f "$stale"
        done
        kit_step "" "downloading intentic-machine${published:+ }${published}…" "Download intentic-machine${published:+ }${published}"
        # curl's own bar only where a person is watching; a pipe (the desktop app, `ic`) gets silence and the line above.
        meter="--silent"
        if [ -t 2 ] && [ "$kit_mode" = rich ]; then
            meter="--progress-bar"
            kit_suspend
        fi
        # By the .gz copy the release publishes beside the binary (42 of the Linux agent's 92 MB), resumed like the binary
        # and unpacked once whole. A release from before the copies answers 404 for it (curl's 22), and so does any
        # error page; then the binary itself is downloaded, as it is on a device with no gzip or an unpacked partial.
        packed=22
        if command -v gzip >/dev/null 2>&1 && [ ! -s "$part" ]; then
            # shellcheck disable=SC2086 # $meter is one deliberate word, chosen just above.
            if curl --fail --location $meter --retry 3 --retry-delay 2 --continue-at - --output "${part}.gz" "${url}.gz"; then
                packed=0
            else
                packed=$?
            fi
        fi
        case "$packed" in
            0)
                if ! gzip -dc "${part}.gz" >"$part" 2>/dev/null; then
                    rm -f "$part" "${part}.gz"
                    kit_stop "intentic-machine could not be installed." "what downloaded is not a working program: a captive portal, a cut-off download, or the wrong architecture." "check the network, then run the same command again."
                fi
                rm -f "${part}.gz"
                ;;
            22)
                rm -f "${part}.gz"
                # shellcheck disable=SC2086 # $meter is one deliberate word, chosen just above.
                if ! curl --fail --location --show-error $meter --retry 3 --retry-delay 2 --continue-at - \
                    --output "$part" "$url"; then
                    kit_stop "intentic-machine could not be downloaded." "the download stopped before it finished; what arrived is kept, and running the same command again resumes it." "check the network, then run the same command again."
                fi
                ;;
            *)
                kit_stop "intentic-machine could not be downloaded." "the download stopped before it finished; what arrived is kept, and running the same command again resumes it." "check the network, then run the same command again."
                ;;
        esac
        kit_resume
        chmod +x "$part"
        case "$(agent_version "$part")" in
            [0-9]*.[0-9]*.[0-9]*) ;;
            *)
                rm -f "$part"
                kit_stop "intentic-machine could not be installed." "what downloaded is not a working program: a captive portal, a cut-off download, or the wrong architecture." "check the network, then run the same command again."
                ;;
        esac
        # Rename into place: overwriting a running executable fails outright ("Text file busy"); a rename swaps the
        # directory entry and leaves any live process on the old inode until it restarts.
        mv -f "$part" "$dest"
        kit_settle
    fi
    BIN="$dest"
}
# ---- end of the agent binary bootstrap ----
# <<< end of generated agent-fetch.sh

# WHICH HALF OF THE AGENT THIS SCRIPT CONNECTS, named once: `sync` here, `device` in device.sh. The bootstrap block probes
# for it and the handover at the bottom makes it, so the two can never disagree.
ROUTE="sync"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in
    linux | darwin) ;;
    *) kit_stop "Desktop sync could not be set up." "this device runs $os, and this command sets up Linux and macOS." "on Windows, use the PowerShell command from the same card." ;;
esac
arch="$(uname -m)"
case "$arch" in
    x86_64 | amd64) arch="amd64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) kit_stop "Desktop sync could not be set up." "this device's processor is $arch, and the device agent is built for amd64 and arm64." ;;
esac

# The Worker's /sync/<host>/<code> passes the pair as arguments. A mangled command, or an env-var one missing a value,
# fails before the download; the code itself is spent after it (below), so a download that breaks leaves it valid for
# the same command. What it stood for lands in the variables an env-var run sets itself.
if [ $# -ge 2 ]; then
    kit_redeem_check "$1" "$2"
elif [ -z "${SANDBOX_URL:-}" ] || [ -z "${PAIR_TOKEN:-}" ]; then
    kit_stop "Desktop sync could not be set up." "the command is missing the sandbox's address or its pairing token." "copy the command again from the Desktop sync card."
fi
REMOTE_DIR="${SYNC_REMOTE_DIR:-}"
PROJECT="${SYNC_PROJECT:-}"
PROJECTS_HOST="${SYNC_PROJECTS_HOST:-}"
# This device's own sandbox holds no folder: folders attach to it later, each as /work/<name>.
if [ -n "$PROJECTS_HOST" ] && { [ -n "${SYNC_DIR:-}" ] || [ -n "$REMOTE_DIR" ] || [ -n "$PROJECT" ]; }; then
    kit_stop "Desktop sync could not be set up." "SYNC_PROJECTS_HOST pairs this device's own sandbox, which holds no folder, and SYNC_DIR, SYNC_REMOTE_DIR or SYNC_PROJECT names one." "unset SYNC_DIR, SYNC_REMOTE_DIR and SYNC_PROJECT, then run the same command again." 2
fi

# THE HANDOVER'S NEWER WORDS: the flags below that an agent older than them refuses outright, so the bootstrap block
# replaces an installed agent whose `setup --help` does not list them. Empty for an ordinary folder.
SPEAKS=""
[ -n "$REMOTE_DIR" ] && SPEAKS="--remote-dir"
[ -n "$PROJECT" ] && SPEAKS="$SPEAKS --project"
[ -n "$PROJECTS_HOST" ] && SPEAKS="$SPEAKS --projects-host"

agent_fetch

# Still not spoken after the bootstrap: the newest release predates the handover's words, and the agent would refuse
# them with a parser error that names a flag and nothing else. Said here instead, in words, before anything is
# connected. A dev AGENT_BIN is taken as it is.
if [ -z "${AGENT_BIN:-}" ] && [ -n "${SPEAKS:-}" ] && ! agent_speaks "$BIN" "$ROUTE" "$SPEAKS"; then
    if [ -n "$PROJECTS_HOST" ]; then
        kit_stop "Desktop sync could not be set up." "intentic-machine $(agent_version "$BIN") on this device cannot set up this device's own sandbox yet, so folders cannot attach to it." "update the desktop app, or run this again once a newer agent is released."
    fi
    kit_stop "Desktop sync could not be set up." "intentic-machine $(agent_version "$BIN") on this device does not understand ${SPEAKS# } yet." "update the desktop app, or run this again once a newer agent is released."
fi

if [ $# -ge 2 ]; then
    kit_redeem "$1" "$2" "$ROUTE"
fi
URL="${SANDBOX_URL:-}"
PAIR="${PAIR_TOKEN:-}"
DIR="${SYNC_DIR:-}"
if [ -z "$URL" ] || [ -z "$PAIR" ]; then
    kit_stop "Desktop sync could not be set up." "the sandbox's answer is missing its address or the pairing token." "get a new command from the Desktop sync card."
fi

set -- "$ROUTE" setup --url "$URL" --pair "$PAIR"
[ -n "$DIR" ] && set -- "$@" --dir "$DIR"
[ -n "$REMOTE_DIR" ] && set -- "$@" --remote-dir "$REMOTE_DIR"
[ -n "$PROJECT" ] && set -- "$@" --project
[ -n "$PROJECTS_HOST" ] && set -- "$@" --projects-host
[ -n "${TAKEOVER:-}" ] && set -- "$@" --takeover
kit_suspend
# AGENT_BIN is a dev command (`node /path/to/cli.js`), split into its words on purpose; the installed agent is one path,
# quoted, so a home folder with a space in it still runs.
if [ -n "${AGENT_BIN:-}" ]; then
    # shellcheck disable=SC2086
    exec $AGENT_BIN "$@"
fi
exec "$BIN" "$@"
