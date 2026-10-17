#!/bin/sh
# intentic connect: a bootstrap shim. It gets Docker onto this device (the one step that may need administrator
# rights), finds or downloads the ic CLI, and hands the flow over to `ic sandbox connect`, which does everything else:
# the setup-code claim, tunnels, the launch, desktop sync. The flow lives in _sandbox/ic; this file stays the thing a
# person can read before piping it into sh.
#
# Usage (the platform's setup screen hands you a copy-paste one-liner):
#   curl -fsSL https://intentic.dev/setup/<SETUP_CODE> | sh
#   curl -fsSL https://intentic.dev/connect | sh -s -- <SETUP_CODE>          (the older shape, still served)
#   Headless/scripted: skip the code and pass everything as env vars (CONNECT_TOKEN=… SANDBOX_GRANT=… ./connect.sh).
#
# The setup code carries the sandbox's reachability grant on intentic's own edge (SANDBOX_GRANT, plus the INGRESS_URL it
# dials); the sandbox opens the tunnel outbound with it from inside. CF_TOKEN is only for SELF_HOST, which publishes THIS
# device's SSH for the deploy engine; it has nothing to do with reaching the sandbox.
#
# ELEVATION IS ASKED FOR, NEVER BAKED IN (docs/ops/cli-output-protocol.md). Installing Docker is the one step that
# needs root, so it is the one step that asks for it, through sudo, after saying why. Everything else is a docker/curl
# call the person can make themselves. A run that already IS root (the older `| sudo sh` one-liners, the desktop app's
# pkexec when Docker is missing) installs without asking for sudo, as before.
#
# The ic binary is downloaded on EVERY run, so re-running the one-liner upgrades an existing install; only a failed
# download falls back to what is installed. IC_BIN overrides for local dev (a checkout's own build). A run the desktop
# app pins to its release copies the ic the app carries (INTENTIC_IC_PATH) instead, when that one is exactly the
# release asked for.
#
# POSIX sh (this is piped into `sh`, which is dash on Debian/Ubuntu/WSL; no `pipefail`).
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

# >>> generated from _site/site/scripts-kit/checkout.sh: edit it there, then run node _tools/checks/scripts-kit.mjs --fix
# THE CHECKOUT THIS SCRIPT WAS RUN OUT OF, or empty when there is none, which is the normal case: the piped
# `curl … | sh` form has no path in $0 at all. Found by walking up to the workspace marker rather than counting levels,
# so it is right wherever the file is served from; every use still GATES on finding the specific file it needs.
checkout_root() {
    case "$0" in
        */*) _dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || return 0 ;;
        *) return 0 ;; # piped curl|sh: no path, no checkout
    esac
    while [ -n "$_dir" ] && [ "$_dir" != "/" ]; do
        if [ -f "$_dir/pnpm-workspace.yaml" ]; then
            printf '%s\n' "$_dir"
            return 0
        fi
        _dir="$(dirname "$_dir")"
    done
}

# ic_from_checkout: run BY PATH from a checkout (the dev platform's one-liners, a hand-run in the repo), prefer the
# checkout's OWN ic: a flow change and its CLI change land in one commit and are tested together, and a released ic may
# predate both. Sets $IC when it built one; IC_BIN, the piped form and a checkout without cargo skip it.
ic_from_checkout() {
    IC="${IC:-${IC_BIN:-}}"
    [ -z "$IC" ] || return 0
    CHECKOUT="$(checkout_root)"
    [ -n "$CHECKOUT" ] || return 0
    ic_manifest="$CHECKOUT/_sandbox/ic/Cargo.toml"
    if [ -f "$ic_manifest" ] && command -v cargo >/dev/null 2>&1; then
        kit_step fetching-ic "building the checkout's ic CLI…" "Build ic from the checkout"
        kit_suspend
        if cargo build --quiet --manifest-path "$ic_manifest"; then
            IC="$CHECKOUT/_sandbox/ic/target/debug/ic"
        else
            kit_warn "the checkout's ic did not build, so the released ic runs instead."
        fi
        kit_resume
        kit_settle
    fi
}
# <<< end of generated checkout.sh

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

# The script curls GitHub (the ic download) and possibly get.docker.com; a device without curl would otherwise fail
# with a raw "command not found" mid-run (direct ./connect.sh runs; the piped form obviously has curl).
if ! command -v curl >/dev/null 2>&1; then
    kit_stop "This device could not be connected." "curl is not installed on this device." "install curl, then run the same command again."
fi

# THE SETUP CODE IS THE FIRST ARGUMENT, and it is lifted out here rather than forwarded in the pile.
#
# It is a value the platform minted, so it may be any string at all, and `-*` cannot tell a code that begins with a
# hyphen from a flag. The flags this shim is ever handed are ic's own and are named one by one for that reason;
# anything else in first position is the code, whatever it starts with. It reaches ic behind `--` (the exec at the
# foot), which is the only place a hyphen-leading value is safe from being read as a flag.
SETUP_CODE=""
if [ $# -gt 0 ]; then
    case "$1" in
        -y | --yes | --force | --replace) ;;
        *)
            SETUP_CODE="$1"
            shift
            ;;
    esac
fi

# Run a command as root: directly when this run already is root, through sudo otherwise, after the one sentence that
# says why (the caller passes it). No sudo on a device that needs it is a stop with the way forward.
as_root() {
    why="$1"
    shift
    if [ "$(id -u)" = 0 ]; then
        "$@"
        return
    fi
    if ! command -v sudo >/dev/null 2>&1; then
        kit_stop "Docker could not be installed." "installing it needs administrator rights, and sudo is not available on this device." "install Docker from https://docs.docker.com/get-docker/, then run the same command again."
    fi
    if [ -z "${as_root_said:-}" ]; then
        kit_say "$why"
        as_root_said=1
    fi
    kit_suspend
    sudo "$@"
    kit_resume
}
ROOT_WHY="Installing Docker changes the system, so sudo asks for your password once."

# Consent gate for installing Docker: a system change beyond the sandbox itself, so never silent. INSTALL_DOCKER=1
# pre-consents (headless runs, the desktop app); otherwise the kit asks on the controlling terminal (the person is at a
# terminal even under `curl … | sh`; stdin is the script), and stops with the remedy when there is nobody to ask.
confirm_install_docker() {
    [ "${INSTALL_DOCKER:-}" = 1 ] && return 0
    kit_confirm "$1" "$2" "INSTALL_DOCKER=1 set, or install Docker yourself from https://docs.docker.com/get-docker/"
}

# Docker Engine via Docker's official convenience script. Enabling dockerd on boot is also what brings the sandbox and
# tunnel containers (--restart unless-stopped) back after a reboot. A person who is not root is added to the docker
# group, so the engine answers them without sudo from then on.
install_docker_linux() {
    confirm_install_docker "Install Docker Engine?" "Docker is not installed. It comes from get.docker.com and runs the sandbox on this device."
    kit_step installing-docker "installing Docker Engine (get.docker.com)…" "Install Docker"
    docker_script="$(mktemp)"
    curl -fsSL https://get.docker.com -o "$docker_script" ||
        kit_stop "Docker could not be installed." "get.docker.com did not answer from this device." "check the network, then run the same command again."
    as_root "$ROOT_WHY" sh "$docker_script"
    rm -f "$docker_script"
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        as_root "$ROOT_WHY" systemctl enable --now docker >/dev/null 2>&1 || true
    elif command -v service >/dev/null 2>&1; then
        as_root "$ROOT_WHY" service docker start >/dev/null 2>&1 || true
    fi
    if [ "$(id -u)" != 0 ]; then
        as_root "$ROOT_WHY" usermod -aG docker "$(id -un)" || true
    fi
}

# Docker Desktop, guided: its dmg ships a CLI installer, so this installs without clicking; only the first-run dialog
# stays manual (the daemon wait below covers it). --accept-license is passed only after the question named Docker's
# terms. --user skips the privileged-helper prompt.
install_docker_macos() {
    confirm_install_docker "Install Docker Desktop?" "Docker Desktop is not installed. It is about 1.5 GB, and installing it accepts Docker's terms (https://www.docker.com/legal/docker-subscription-service-agreement)."
    case "$(uname -m)" in
        arm64) dmg_arch="arm64" ;;
        *) dmg_arch="amd64" ;;
    esac
    dmg="$(mktemp -d)/Docker.dmg"
    kit_step installing-docker "downloading Docker Desktop (~1.5 GB)…" "Download Docker Desktop"
    kit_suspend
    curl -fL "https://desktop.docker.com/mac/main/${dmg_arch}/Docker.dmg" -o "$dmg" ||
        kit_stop "Docker Desktop could not be downloaded." "desktop.docker.com did not answer from this device." "check the network, then run the same command again."
    kit_resume
    kit_step installing-docker "installing Docker Desktop…" "Install Docker Desktop"
    hdiutil attach "$dmg" -nobrowse -quiet
    as_root "$ROOT_WHY" /Volumes/Docker/Docker.app/Contents/MacOS/install --accept-license --user="${SUDO_USER:-$(id -un)}"
    hdiutil detach /Volumes/Docker -quiet || true
    rm -f "$dmg"
    # Docker Desktop is a user-session app: launch it as the person, not as root.
    if [ -n "${SUDO_USER:-}" ] && [ "$(id -u)" = 0 ]; then
        sudo -u "$SUDO_USER" open -a Docker
    else
        open -a Docker
    fi
}

kit_step checking-docker "checking Docker…" "Check Docker"
DOCKER_INSTALLED=""
if ! command -v docker >/dev/null 2>&1; then
    case "$(uname -s)" in
        Linux) install_docker_linux ;;
        Darwin) install_docker_macos ;;
        *) kit_stop "Docker is not installed." "this device runs $(uname -s), where intentic cannot install it." "install Docker Desktop from https://docs.docker.com/get-docker/, then run the same command again." ;;
    esac
    DOCKER_INSTALLED=1
    # A freshly installed daemon takes a moment (Docker Desktop: first-run dialog and VM boot), so wait up to 5 min.
    # An already-installed but unreachable daemon is diagnosed by ic instead (it can tell a stopped daemon from one
    # this person may not talk to). The person was only just added to the docker group, which this session does not
    # carry yet, so the wait asks as root when it has to.
    kit_step installing-docker "waiting for the Docker daemon (accept Docker Desktop's first-run dialog if shown)…" "Wait for Docker to start"
    i=0
    until docker version --format '{{.Server.Version}}' >/dev/null 2>&1 ||
        { [ "$(uname -s)" = Linux ] && [ "$(id -u)" != 0 ] && sudo -n docker version --format '{{.Server.Version}}' >/dev/null 2>&1; }; do
        i=$((i + 1))
        if [ "$i" -ge 60 ]; then
            kit_stop "Docker did not start." "its engine did not answer within 5 minutes." "start Docker, then run the same command again."
        fi
        sleep 5
    done
fi
kit_settle

# A registry-less SANDBOX_IMAGE run from a checkout is rebuilt from it below (checkout_root is in the generated region).
CHECKOUT="$(checkout_root)"

# Dev QoL that must live HERE, not in ic: a registry-less SANDBOX_IMAGE (e.g. intentic-sandbox:dev) run BY PATH from a
# checkout is rebuilt from that checkout on EVERY run, since a cached image would otherwise silently outlive Dockerfile or
# source edits, and docker's layer cache makes an unchanged rebuild near-instant.
case "${SANDBOX_IMAGE:-}" in
    "" | *.*/* | *:*/* | localhost/*) ;; # empty or registry-carrying: nothing to rebuild
    *)
        repo_root="$CHECKOUT"
        if [ -n "$repo_root" ] && [ -f "$repo_root/_sandbox/sandbox/Dockerfile" ]; then
            kit_step pulling-image "building the local sandbox image ${SANDBOX_IMAGE} from your checkout (cached when unchanged; the first build takes a few minutes)…" "Build $SANDBOX_IMAGE from the checkout"
            kit_suspend
            if ! bash "$repo_root/_tools/scripts/image/build-sandbox-image.sh" "$SANDBOX_IMAGE"; then
                if docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then
                    kit_warn "building $SANDBOX_IMAGE failed (the docker output above says why), so the previous local build runs, without your latest changes."
                else
                    kit_stop "$SANDBOX_IMAGE could not be built." "the docker output above says why." "fix the build, or unset SANDBOX_IMAGE to use the published image."
                fi
            fi
            kit_resume
            kit_settle
        fi
        ;;
esac

IC="${IC_BIN:-}"
ic_from_checkout
ic_fetch

# Everything else (claim, tunnels, launch, sync) is ic's. Flags pass through untouched; the setup code goes last,
# behind `--`, so a code beginning with a hyphen is a value rather than an unknown flag. The env this shell carries
# (CF_TOKEN, SANDBOX_IMAGE, SELF_HOST, SYNC_DIR, …) rides along. A person this run just added to the docker group does
# not carry that group in this session yet, so ic runs under it through sudo, as that same person.
kit_suspend
if [ -n "$DOCKER_INSTALLED" ] && [ "$(id -u)" != 0 ] && ! docker version >/dev/null 2>&1; then
    if [ -n "$SETUP_CODE" ]; then
        exec sudo -E -u "$(id -un)" -g docker "$IC" sandbox connect "$@" -- "$SETUP_CODE"
    fi
    exec sudo -E -u "$(id -un)" -g docker "$IC" sandbox connect "$@"
fi
if [ -n "$SETUP_CODE" ]; then
    exec "$IC" sandbox connect "$@" -- "$SETUP_CODE"
fi
exec "$IC" sandbox connect "$@"
