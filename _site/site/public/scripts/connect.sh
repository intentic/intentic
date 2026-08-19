#!/bin/sh
# intentic connect — bootstrap shim: get Docker onto this machine (the ONE step that needs a dependency-free,
# possibly-root start), fetch the `ic` CLI, and hand the flow over to `ic sandbox connect`, which does
# everything else — the setup-code claim, tunnels, the launch, desktop sync. The flow lives in _sandbox/ic;
# this file stays the thing a user can read before piping into sh.
#
# Usage (the platform's setup screen hands you a copy-paste one-liner):
#   curl -fsSL https://intentic.dev/connect | sudo sh -s -- <SETUP_CODE>
#   Headless/scripted: skip the code and pass everything as env vars (CONNECT_TOKEN=… ZROK_TOKEN=… ./connect.sh).
#
# The setup code carries the sandbox's reachability grant on intentic's own tunnel hub; the sandbox enables
# with it from inside. CF_TOKEN is only for SELF_HOST, which publishes THIS machine's SSH for the deploy
# engine — it has nothing to do with reaching the sandbox.
#
# The `sudo` is for INSTALLING DOCKER and nothing else — every other step is a docker/curl call the invoking
# user can make themselves (SELF_HOST=1 is the one opt-in that needs root for its own reasons; ic acquires it
# itself). Drop it on a machine that already has Docker; the setup page offers exactly that as "I already
# have Docker", and a sudo-less run that then finds no Docker stops with the two ways forward rather than
# escalating on its own.
#
# The ic binary is downloaded on EVERY run, so re-running the one-liner upgrades an existing install; only a
# failed download falls back to what's installed. IC_BIN overrides for local dev (a checkout's own build).
# POSIX sh (this is piped into `sh`, which is dash on Debian/Ubuntu/WSL — no `pipefail`).
set -eu

# The script curls GitHub (the ic download) and possibly get.docker.com; a box without curl would otherwise
# fail with a raw "command not found" mid-run (direct ./connect.sh runs — the piped form obviously has curl).
if ! command -v curl >/dev/null 2>&1; then
    echo "error: curl is required — install it and re-run." >&2
    exit 1
fi

# A PHASE OF THE INSTALL, ANNOUNCED ONCE — prose for a terminal, and a name for anything watching.
#
# The desktop app spawns this script and turns its stdout into a progress bar, so it has to know WHICH phase
# started; recognising the sentence would mean every rewording silently moved somebody's bar. Same contract as
# ic's util::step, and the same vocabulary — anything echoed WITHOUT a phase is detail under the step that is
# running, never a step of its own.
#
# The two audiences are split the same way ic splits them (its ui.rs): a PIPE gets the marker, unchanged and
# forever, because something is parsing it. A TERMINAL gets the sentence alone — the bracketed id there says
# the same thing twice in a shape that reads like an error code, and these two lines sit directly above the
# checklist ic is about to draw, where they would otherwise look like a different program's output.
#
# This shim keeps NARRATING either way. Going quiet in a terminal would be silence across a Docker install
# that can run ten minutes, which is the one stretch of this script that most needs to say something.
step() {
    if [ -t 1 ]; then
        printf '  ·  %s\n' "$2"
    else
        echo "intentic: [$1] $2"
    fi
}

# Peek at the args only as far as the failure messages need (the first non-flag positional is the setup
# code); everything is forwarded to ic untouched, which owns the real parsing.
SETUP_CODE_PEEK=""
for arg in "$@"; do
    case "$arg" in
        -*) ;;
        *)
            SETUP_CODE_PEEK="$arg"
            break
            ;;
    esac
done

# The one-liner carries `sudo` ONLY so that a missing Docker can be installed. Docker is missing and we are
# not root, so there is nothing to do but name the two ways forward. Printing the exact command back is the
# point — the user is looking at a terminal, not at the setup page. The own-Cloudflare command carries
# CF_TOKEN, which is NOT echoed back: a secret that reached this shell in a paste does not get reprinted.
require_root_to_install_docker() {
    echo "error: Docker is not installed, and installing it needs root — this command is running without sudo." >&2
    echo >&2
    echo "  Install Docker yourself, then re-run this exact command:" >&2
    echo "      https://docs.docker.com/get-docker/" >&2
    echo >&2
    echo "  …or let intentic install it, by re-running with sudo:" >&2
    if [ -n "${CF_TOKEN:-}" ]; then
        echo "      copy the command from the setup page again with \"I already have Docker\" switched off" >&2
    elif [ -n "$SETUP_CODE_PEEK" ]; then
        echo "      curl -fsSL https://intentic.dev/connect | sudo sh -s -- $SETUP_CODE_PEEK" >&2
    else
        echo "      curl -fsSL https://intentic.dev/connect | sudo sh" >&2
    fi
    exit 1
}

# Consent gate for installing Docker: a root-level system change beyond the sandbox itself, so never silent.
# INSTALL_DOCKER=1 pre-consents (headless runs); otherwise ask on /dev/tty (the human is at a terminal even
# under `curl … | sh` — stdin is the script), and fail with the remedy when there is no terminal to ask.
#
# WHETHER /dev/tty CAN BE OPENED is the question, and `[ -r /dev/tty ]` does not answer it: the node is
# world-readable on every machine, but opening it fails with ENXIO whenever the process has no CONTROLLING
# terminal — a systemd unit, a CI step, anything under `setsid`. That test passed in exactly those cases, and
# the one prompt that must never be silent silently approved a root-level install on every headless run.
# Probed in a SUBSHELL because a redirection error on a special built-in may exit the shell outright, and a
# failed read is a refusal rather than consent.
confirm_install_docker() {
    if [ "${INSTALL_DOCKER:-}" = "1" ]; then
        return 0
    fi
    if ! (exec </dev/tty) 2>/dev/null; then
        echo "error: docker is not installed and there is no terminal to ask — re-run with INSTALL_DOCKER=1" >&2
        echo "       to install it automatically, or install it yourself: https://docs.docker.com/get-docker/" >&2
        exit 1
    fi
    printf '%s [Y/n] ' "$1" >&2
    read -r answer </dev/tty || answer="n"
    case "$answer" in
        n* | N*)
            echo "error: docker is required — install it (https://docs.docker.com/get-docker/) and re-run." >&2
            exit 1
            ;;
    esac
}

# Docker Engine via Docker's official convenience script. Enabling dockerd on boot is also what brings the
# sandbox + tunnel containers (--restart unless-stopped) back after a reboot. Reached only as root (the
# caller guards), so nothing here escalates behind the user's back.
install_docker_linux() {
    confirm_install_docker "intentic: Docker is not installed. Install it now via get.docker.com?"
    step installing-docker "installing Docker Engine (get.docker.com)…"
    curl -fsSL https://get.docker.com | sh
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        systemctl enable --now docker >/dev/null 2>&1 || true
    elif command -v service >/dev/null 2>&1; then
        service docker start >/dev/null 2>&1 || true
    fi
}

# Docker Desktop, guided: its dmg ships a CLI installer, so under the one-liner's sudo this installs without
# clicking — only the first-run dialog stays manual (the daemon wait below covers it). --accept-license is
# passed only after the consent prompt named Docker's terms. --user skips the privileged-helper prompt.
install_docker_macos() {
    confirm_install_docker "intentic: Docker Desktop is not installed. Download (~1.5 GB) and install it now? Continuing accepts Docker's terms (https://www.docker.com/legal/docker-subscription-service-agreement)."
    case "$(uname -m)" in
        arm64) dmg_arch="arm64" ;;
        *) dmg_arch="amd64" ;;
    esac
    dmg="$(mktemp -d)/Docker.dmg"
    step installing-docker "downloading Docker Desktop (~1.5 GB)…"
    curl -fL "https://desktop.docker.com/mac/main/${dmg_arch}/Docker.dmg" -o "$dmg"
    step installing-docker "installing Docker Desktop…"
    hdiutil attach "$dmg" -nobrowse -quiet
    /Volumes/Docker/Docker.app/Contents/MacOS/install --accept-license --user="${SUDO_USER:-$USER}"
    hdiutil detach /Volumes/Docker -quiet || true
    rm -f "$dmg"
    # Docker Desktop is a user-session app — launch it as the human who invoked sudo, not as root.
    if [ -n "${SUDO_USER:-}" ]; then
        sudo -u "$SUDO_USER" open -a Docker
    else
        open -a Docker
    fi
}

step checking-docker "checking Docker…"
if ! command -v docker >/dev/null 2>&1; then
    # Installing Docker is the ONE thing here that needs root, so it is also the one thing that can fail on a
    # deliberately sudo-less run — say so with the remedy instead of escalating behind the user's back.
    [ "$(id -u)" = 0 ] || require_root_to_install_docker
    case "$(uname -s)" in
        Linux) install_docker_linux ;;
        Darwin) install_docker_macos ;;
        *)
            echo "error: docker is not installed. Install Docker Desktop (https://docs.docker.com/get-docker/), then re-run." >&2
            exit 1
            ;;
    esac
    # A freshly installed daemon takes a moment (Docker Desktop: first-run dialog + VM boot) — wait up to
    # 5 min. An already-installed-but-unreachable daemon is diagnosed by ic instead (it can tell a stopped
    # daemon from one this user may not talk to).
    step installing-docker "waiting for the Docker daemon (accept Docker Desktop's first-run dialog if shown)…"
    i=0
    until docker version --format '{{.Server.Version}}' >/dev/null 2>&1; do
        i=$((i + 1))
        if [ "$i" -ge 60 ]; then
            echo "error: the Docker daemon did not come up — start Docker, then re-run this command." >&2
            exit 1
        fi
        sleep 5
    done
fi

# THE CHECKOUT THIS SCRIPT WAS RUN OUT OF, or empty when there isn't one — which is the normal case, since the
# piped `curl … | sh` form has no path in $0 at all.
#
# Found by walking up to the workspace marker rather than counting a fixed number of levels. This file is
# served from two places in the repo (_site/site/public/scripts and the built _apps/site/dist/scripts), and a
# fixed `../../../..` is only right while both stay exactly four deep; a walk is right wherever it is served
# from, and survives being copied, moved or symlinked. Everything below still GATES on finding the specific
# file it needs, so an unrelated checkout that happens to be a pnpm workspace falls through exactly as before.
# CANNOT be shared with _tools/scripts/repo-root.sh: this file is downloaded and run on its own.
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

# Dev QoL that must live HERE, not in ic: a registry-less SANDBOX_IMAGE (e.g. intentic-sandbox:dev) run BY
# PATH from a checkout is rebuilt from that checkout on EVERY run — a cached image would otherwise silently
# outlive Dockerfile or source edits, and docker's layer cache makes an unchanged rebuild near-instant. The
# ic binary ships without a checkout, so only this script (which has a path when invoked by path — the piped
# curl|sh form has none, and then simply runs the existing local image) can do this.
case "${SANDBOX_IMAGE:-}" in
    "" | *.*/* | *:*/* | localhost/*) ;; # empty or registry-carrying — nothing to rebuild
    *)
        repo_root="$CHECKOUT"
        if [ -n "$repo_root" ] && [ -f "$repo_root/_sandbox/sandbox/Dockerfile" ]; then
            step pulling-image "building the local sandbox image ${SANDBOX_IMAGE} from your checkout (cached when unchanged; the first build takes a few minutes)…"
            if ! (cd "$repo_root" && bash _tools/scripts/prepare-image-trees.sh &&
                node _tools/scripts/compose-image-dockerfile.mjs standard > .image-out/Dockerfile.standard &&
                docker build --build-context trees=.image-out -f .image-out/Dockerfile.standard -t "$SANDBOX_IMAGE" .); then
                if docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then
                    echo "intentic: building ${SANDBOX_IMAGE} failed (see the docker output above) — continuing with the PREVIOUS local build, which does NOT include your latest changes." >&2
                else
                    echo "intentic: building ${SANDBOX_IMAGE} failed (see the docker output above) — fix the build, or unset SANDBOX_IMAGE to use the published image." >&2
                    exit 1
                fi
            fi
        fi
        ;;
esac

# ---- fetch the ic CLI (keep in lockstep with recreate.sh / connect-host.sh — standalone curl|sh files) ----
IC="${IC_BIN:-}"
# Run BY PATH from a checkout (the dev platform's one-liners), prefer the checkout's OWN ic — a flow change
# and its CLI change land in one commit and are tested together, and a released ic may predate both. The
# piped curl|sh form has no path in $0 and skips this; so does a checkout without cargo.
if [ -z "$IC" ] && [ -n "$CHECKOUT" ]; then
    ic_manifest="$CHECKOUT/_sandbox/ic/Cargo.toml"
    if [ -f "$ic_manifest" ] && command -v cargo >/dev/null 2>&1; then
        step fetching-ic "building the checkout's ic CLI…"
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
            echo "error: unsupported OS '$os' — on Windows use the .ps1 one-liner from the setup page." >&2
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
    if [ "$(id -u)" = 0 ]; then
        dest="/usr/local/bin/ic"
    else
        dest="$HOME/.intentic/ic/bin/ic"
        mkdir -p "$(dirname "$dest")"
    fi
    step fetching-ic "fetching the ic CLI…"
    # Download beside the target and rename into place: overwriting a running executable fails outright
    # ("Text file busy"), and a half-downloaded binary must never be what runs.
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

# Everything else — claim, tunnels, launch, sync — is ic's. Args pass through untouched (the setup code
# positional, -y); the env this shell carries (CF_TOKEN, SANDBOX_IMAGE, SELF_HOST, …) rides along.
exec "$IC" sandbox connect "$@"
