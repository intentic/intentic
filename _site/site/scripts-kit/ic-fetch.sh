# ic_fetch: find or download the ic CLI into $IC, unless $IC is already set. IC_BIN overrides (a checkout's own
# build). An unpinned run downloads every time, which is how re-running a one-liner upgrades a device; only a failed
# download falls back to an installed ic. Download beside the target and rename into place: overwriting a running
# executable fails outright ("Text file busy"), and a half-downloaded binary must never be what runs. What arrives is
# probed by running it before it replaces anything: a 200 can be a captive portal's login page or an empty body.
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
        # curl's own sentence would land on the live line; the stop below says the same thing in this page's words.
        if ic_carried || curl -fsL "${ic_base}/ic-${os}-${arch}" -o "${dest}.tmp" 2>/dev/null; then
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
            if [ -n "$IC" ]; then
                kit_warn "the newest ic could not be downloaded, so the one installed at $IC runs instead."
            else
                kit_stop "ic could not be downloaded, and no copy is installed." "$ic_why" "check the network, then run the same command again."
            fi
        fi
        kit_settle
    fi
}
