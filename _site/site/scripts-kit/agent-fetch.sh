# ---- bootstrap the agent binary (identical in device.sh and sync.sh) ----
# Bootstrap only if the installed agent cannot run the handover's help; version alone does not prove route/flag compatibility.
# Pin downloads to the tag resolved by releases/latest so interrupted transfers cannot splice releases.
# Check the download against the release's SHA256SUMS before it first runs, then run version before installing it to
# reject broken downloads. Inputs: ROUTE, SPEAKS, os, arch; output: BIN.

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

# agent_sha256 <file>: its SHA-256 in hex, by sha256sum (Linux) or shasum (macOS); nothing when neither is installed.
agent_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

# agent_checked <file> <asset> <sums url>: the file is the asset the release published, by its SHA256SUMS line. Otherwise
# sets agent_why and agent_fix and fails, and so does every way the check cannot be made: a binary this script runs next
# is never taken on trust (2026-11-24). The release also signs SHA256SUMS (SHA256SUMS.sig, minisign); checking it here
# would need minisign on the device, so the sums come from the same https origin as the binary and the signature is left
# to the agent, which checks it before it replaces itself.
agent_checked() {
    agent_sum_got="$(agent_sha256 "$1" || true)"
    if [ -z "$agent_sum_got" ]; then
        agent_why="neither sha256sum nor shasum is installed, so the download cannot be checked against the release's SHA256SUMS."
        agent_fix="install either one, then run the same command again."
        return 1
    fi
    agent_fix="run the same command again; if it fails the same way, something between this device and github.com is altering the download."
    agent_sums="$(curl -fsL --max-time 30 "$3" 2>/dev/null || true)"
    if [ -z "$agent_sums" ]; then
        agent_why="the release's SHA256SUMS did not download, so intentic-machine cannot be checked against it."
        agent_fix="check the network, then run the same command again."
        return 1
    fi
    agent_sum_want="$(printf '%s\n' "$agent_sums" | awk -v asset="$2" '
        { name = $2; sub(/^\*/, "", name); sub(/^\.\//, "", name) }
        name == asset { want = tolower($1) }
        END { print want }')"
    if [ -z "$agent_sum_want" ]; then
        agent_why="the release's SHA256SUMS lists no $2, so the download cannot be checked."
        return 1
    fi
    [ "$agent_sum_got" = "$agent_sum_want" ] && return 0
    agent_why="the downloaded intentic-machine is not the one the release published (SHA-256 $agent_sum_got, its SHA256SUMS says $agent_sum_want), so it was deleted without being run."
    return 1
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
        asset="intentic-machine-${os}-${arch}"
        if [ -n "$published" ]; then
            url="${releases}/download/v${published}/${asset}"
            sums="${releases}/download/v${published}/SHA256SUMS"
            part="${dest}.part-${published}"
        else
            url="${releases}/latest/download/${asset}"
            sums="${releases}/latest/download/SHA256SUMS"
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
        # Checked before it is first run (the probe below runs it). A partial that fails is deleted, so the next run
        # downloads it whole instead of resuming bytes that can never match.
        if ! agent_checked "$part" "$asset" "$sums"; then
            rm -f "$part"
            kit_stop "intentic-machine could not be installed." "$agent_why" "$agent_fix"
        fi
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
