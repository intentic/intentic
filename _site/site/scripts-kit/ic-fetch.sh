# ic_fetch: find or download the ic CLI into $IC, unless $IC is already set. IC_BIN overrides (a checkout's own
# build). An unpinned run downloads every time, which is how re-running a one-liner upgrades a device; only a failed
# download falls back to an installed ic. Download beside the target and rename into place: overwriting a running
# executable fails outright ("Text file busy"), and a half-downloaded binary must never be what runs. What arrives is
# checked against the release's SHA256SUMS before anything runs it (a mismatch is deleted unrun, and the ic already
# installed stays), then probed by running it before it replaces anything: a 200 can be a captive portal's login page
# or an empty body. IC_SKIP_CHECKSUM=1 installs it unchecked where the check cannot be made at all (no sha256sum or
# shasum, no SHA256SUMS beside IC_URL, or one that lists no ic); it never lets a mismatch through.
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
        ic_seen="$( ("$1" --version) 2>/dev/null)"
        case "$ic_seen" in
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
        # The sum listed for the asset; nothing when it is not listed. A file that names no ic at all is a release from
        # before its SHA256SUMS covered ic (2026-10-16), or a sums file somebody else wrote: either way nothing vouches
        # for the download, so it is refused like a mismatch unless IC_SKIP_CHECKSUM=1 (2026-11-24). Installing it with a
        # note was rejected: a sums file that left ic out was all it took to install an unchecked binary.
        ic_sum_want="$(printf '%s\n' "$ic_sums" | awk -v asset="$2" '
            { name = $2; sub(/^\*/, "", name); sub(/^\.\//, "", name) }
            name == asset { want = tolower($1) }
            END { print want }')"
        if [ -z "$ic_sum_want" ]; then
            if [ "${IC_SKIP_CHECKSUM:-}" = 1 ]; then
                kit_warn "the release's SHA256SUMS lists no $2, so ic is installed unchecked (IC_SKIP_CHECKSUM=1)."
                return 0
            fi
            ic_why="the release's SHA256SUMS lists no $2, so the download cannot be checked."
            ic_fix="run the same command again; if it says the same, report it: the release is missing a checksum. IC_SKIP_CHECKSUM=1 installs ic unchecked from a release older than its checksums."
            return 1
        fi
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
        # ic_runs already asked the binary; compare that answer without starting it a second time.
        ic_have="${1#ic }"
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
        # A trailing separator lets shell builtins consume each component, including an absent one, without
        # starting six cut processes just to compare a three-part version.
        ic_have="${ic_have}."
        ic_want="${ic_want}."
        for ic_part in 1 2 3; do
            ic_h="${ic_have%%.*}"
            ic_w="${ic_want%%.*}"
            ic_have="${ic_have#*.}"
            ic_want="${ic_want#*.}"
            case "$ic_h" in "" | *[!0-9]*) return 1 ;; esac
            case "$ic_w" in "" | *[!0-9]*) return 1 ;; esac
            [ "$ic_h" -gt "$ic_w" ] && return 0
            [ "$ic_h" -lt "$ic_w" ] && return 1
        done
        [ -z "$ic_have_pre" ] || [ "$ic_have_pre" = "$ic_want_pre" ]
    }
    if [ -n "${IC_VERSION:-}" ] && ic_runs "$dest" && ic_not_older "$ic_seen" "$IC_VERSION"; then
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
        # Why ic is not installed, by what failed (2026-11-20, intentic#49): ic_why once said "<host> did not answer"
        # whatever failed, so a device that could not write its own ic was told to check a network that was fine.
        # Empty is the network, said with curl's own words; "refused" a download that arrived and was not installed;
        # "write" a file this device would not write.
        ic_refused=""
        ic_arrived=""
        # ic_download <asset> <file>: the asset into <file>, by the .gz copy each release publishes beside it (under half
        # the bytes) where gzip can unpack it, else by the asset itself, which every release from before the copies
        # answers for. What lands is checked against the asset's own line in SHA256SUMS either way. The second curl's
        # complaint is kept in ic_said rather than shown: exit 23 is curl failing to write <file>, not the network.
        ic_download() {
            if command -v gzip >/dev/null 2>&1 && curl -fsL "${ic_base}/$1.gz" -o "$2.gz" 2>/dev/null && gzip -dc "$2.gz" >"$2" 2>/dev/null; then
                rm -f "$2.gz"
                return 0
            fi
            rm -f "$2.gz"
            ic_status=0
            ic_said="$(curl -fsSL "${ic_base}/$1" -o "$2" 2>&1)" || ic_status=$?
            ic_said="$(printf '%s' "$ic_said" | tr '\n' ' ' | sed 's/ *$//')"
            [ "$ic_status" = 0 ] && return 0
            if [ "$ic_status" = 23 ]; then
                ic_refused=write
                ic_why="could not write $2: ${ic_said:-curl could not save the download there}."
                ic_fix="check that $(dirname "$2") is writable and has room, then run the same command again."
            elif [ -n "$ic_said" ]; then
                ic_why="${ic_host%%/*} did not answer from this device (${ic_said})."
            fi
            return 1
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
                ic_refused=refused
            fi
        fi
        if [ -n "$ic_arrived" ]; then
            chmod +x "${dest}.tmp"
            # mv over a running ic is safe here (the running one keeps its inode), so only its failure needs words: under
            # set -e a bare mv ended the script with mv's own line and no stop block.
            if ! ic_runs "${dest}.tmp"; then
                ic_why="what downloaded is not a working program: a captive portal, a cut-off download, or the wrong architecture."
            elif ic_said="$(mv -f "${dest}.tmp" "$dest" 2>&1)"; then
                IC="$dest"
                if [ "$(id -u)" != 0 ]; then
                    mkdir -p "$HOME/.local/bin"
                    ln -sf "$dest" "$HOME/.local/bin/ic"
                fi
            else
                ic_refused=write
                ic_why="could not write $dest: $(printf '%s' "${ic_said:-mv failed}" | tr '\n' ' ' | sed 's/ *$//')."
                ic_fix="check that $(dirname "$dest") is writable, then run the same command again."
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
            elif [ "$ic_refused" = write ]; then
                kit_stop "ic could not be installed, and no copy is installed." "$ic_why" "$ic_fix"
            elif [ -n "$ic_refused" ]; then
                kit_stop "ic was downloaded but not installed, and no copy is installed." "$ic_why" "$ic_fix"
            else
                kit_stop "ic could not be downloaded, and no copy is installed." "$ic_why" "$ic_fix"
            fi
        fi
        kit_settle
    fi
}
