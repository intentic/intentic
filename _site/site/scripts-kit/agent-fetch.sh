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
        # A partial from another release is bytes that can never be finished.
        for stale in "${dest}".part*; do
            [ "$stale" = "$part" ] || rm -f "$stale"
        done
        kit_step "" "downloading intentic-machine${published:+ }${published}…" "Download intentic-machine${published:+ }${published}"
        # curl's own bar only where a person is watching; a pipe (the desktop app, `ic`) gets silence and the line above.
        meter="--silent"
        if [ -t 2 ] && [ "$kit_mode" = rich ]; then
            meter="--progress-bar"
            kit_suspend
        fi
        # shellcheck disable=SC2086 # $meter is one deliberate word, chosen just above.
        if ! curl --fail --location --show-error $meter --retry 3 --retry-delay 2 --continue-at - \
            --output "$part" "$url"; then
            kit_stop "intentic-machine could not be downloaded." "the download stopped before it finished; what arrived is kept, and running the same command again resumes it." "check the network, then run the same command again."
        fi
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
