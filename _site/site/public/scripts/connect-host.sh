#!/bin/sh
# intentic connect-host — bootstrap shim: get Docker onto this server, fetch the `ic` CLI, and hand over to
# `ic machine enroll`, which does the enrolment — service user + SSH key, this host's own Cloudflare tunnel,
# the POST /enroll self-registration. The flow lives in _sandbox/ic; this file stays the thing a user can
# read before piping into sh. It does NOT create or recreate a sandbox — that already exists from setup.
#
# CF_TOKEN creates this host's tunnel + DNS on your zone (ZONE is optional — the token's own zone is resolved
# when it names exactly one). This is the one path: a deploy target is reached over SSH, and intentic's own
# tunnels carry web traffic, so the Infra screen always hands you the Cloudflare form of the one-liner.
#     curl -fsSL https://intentic.dev/connect-host \
#       | sudo env SANDBOX_URL=… CONNECT_TOKEN=… CF_TOKEN=… ZONE=… HOST_NAME=… sh
# A tunnel minted elsewhere can still be handed in directly, skipping the Cloudflare call:
#     curl -fsSL https://intentic.dev/connect-host \
#       | sudo env SANDBOX_URL=… CONNECT_TOKEN=… HOST_SSH_TUNNEL_TOKEN=… HOST_SSH_HOSTNAME=… HOST_NAME=… sh
#
# The ic binary is downloaded on EVERY run, so re-running the one-liner upgrades an existing install; only a
# failed download falls back to what's installed. IC_BIN overrides for local dev (a checkout's own build).
# POSIX sh (piped into `sh`, which is dash on Debian/Ubuntu/WSL — no `pipefail`).
set -eu

if ! command -v curl >/dev/null 2>&1; then
    echo "error: curl is required — install it and re-run." >&2
    exit 1
fi

# Enrollment mutates the host (creates a user, installs packages), so it needs root — checked here, before a
# Docker install could need it mid-flow. Prefer already-root, else passwordless sudo.
if [ "$(id -u)" = 0 ]; then
    SUDO=""
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    SUDO="sudo -n"
else
    echo "error: connect-host needs root — re-run as root (sudo -i) or enable passwordless sudo." >&2
    exit 1
fi

echo "intentic: checking Docker…"
if ! command -v docker >/dev/null 2>&1; then
    # Deploy targets are standard Linux servers, so install Docker Engine via Docker's official convenience
    # script — with consent (a root-level system change), pre-given via INSTALL_DOCKER=1 for headless runs.
    if [ "${INSTALL_DOCKER:-}" != "1" ]; then
        # The OPEN is the probe, in a subshell — `[ -r /dev/tty ]` passes even where opening fails (no
        # controlling terminal: systemd, cron, setsid), and the fallback answer then silently approved a
        # root-level install on every headless run. A failed read is a refusal.
        if ! (exec </dev/tty) 2>/dev/null; then
            echo "error: docker is not installed and there is no terminal to ask — re-run with INSTALL_DOCKER=1" >&2
            echo "       to install it automatically, or install it yourself: https://docs.docker.com/engine/install/" >&2
            exit 1
        fi
        printf 'intentic: Docker is not installed. Install it now via get.docker.com? [Y/n] ' >&2
        read -r answer </dev/tty || answer="n"
        case "$answer" in
            n* | N*)
                echo "error: docker is required — install it (https://docs.docker.com/engine/install/) and re-run." >&2
                exit 1
                ;;
        esac
    fi
    echo "intentic: installing Docker Engine (get.docker.com)…"
    curl -fsSL https://get.docker.com | $SUDO sh
    # Enable on boot + start now — also what brings deployed containers back after a reboot.
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
    elif command -v service >/dev/null 2>&1; then
        $SUDO service docker start >/dev/null 2>&1 || true
    fi
    # A freshly installed daemon takes a moment to come up.
    i=0
    until docker version --format '{{.Server.Version}}' >/dev/null 2>&1; do
        i=$((i + 1))
        if [ "$i" -ge 10 ]; then
            echo "error: the Docker daemon did not come up — start Docker, then re-run." >&2
            exit 1
        fi
        sleep 2
    done
fi

# ---- fetch the ic CLI (keep in lockstep with connect.sh / recreate.sh — standalone curl|sh files) ----
IC="${IC_BIN:-}"
if [ -z "$IC" ]; then
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    if [ "$os" != "linux" ]; then
        echo "error: connect-host enrolls Linux servers; on a Windows PC use the .ps1 one-liner from the Infra screen." >&2
        exit 1
    fi
    arch="$(uname -m)"
    case "$arch" in
        x86_64 | amd64) arch="amd64" ;;
        arm64 | aarch64) arch="arm64" ;;
        *)
            echo "error: unsupported CPU arch '$arch'." >&2
            exit 1
            ;;
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
        if curl -fsSL "${IC_URL:-https://github.com/intentic/intentic/releases/latest/download}/ic-${os}-${arch}" -o "${dest}.tmp"; then
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

# The enrolment — user, sshd, tunnel, /enroll — is ic's. The env this shell carries (SANDBOX_URL,
# CONNECT_TOKEN, CF_TOKEN/ZONE or the pre-provisioned tunnel values, HOST_NAME, HOST_USER) rides along.
exec "$IC" machine enroll
