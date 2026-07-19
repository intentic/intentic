#!/bin/sh
# intentic connect — run the AI-agent workspace sandbox on THIS machine and expose it to your browser, so a
# user without their own server can drive a project from their PC.
#
# How: the platform mints a per-project connection token and hands you this one-liner. The script creates the
# sandbox's OWN Cloudflare tunnel (sandbox-<id>.<zone> → the daemon, plus the *.<zone> wildcard → the panel previews),
# starts the published sandbox image as a long-lived privileged container carrying its own ISOLATED Docker
# Engine (dockerd inside the sandbox — never the host's Docker socket), and runs a cloudflared sidecar. The browser then talks to the sandbox DIRECTLY over that tunnel — the daemon verifies
# your Google sign-in, and the platform stays off the command path (it never reaches into your machine). The
# setup screen binds the sandbox's public URL itself and probes it until the daemon answers.
#
# Usage (the platform's setup screen hands you a copy-paste one-liner):
#   curl -fsSL https://intentic.dev/connect | sudo sh -s -- <SETUP_CODE>                 (intentic-provided tunnel)
#   curl -fsSL https://intentic.dev/connect | sudo env CF_TOKEN=… sh -s -- <SETUP_CODE>  (own Cloudflare)
#   Headless/scripted: skip the code and pass everything as env vars (CONNECT_TOKEN=… CF_TOKEN=… ./connect.sh).
#
# Required:
#   SETUP_CODE     the short-lived code the platform mints ($1 or env) — redeemed at ${PLATFORM_URL}/setup/claim
#                  below for CONNECT_TOKEN + the tunnel/zone values, so no raw token rides in the command line.
#                  Without a code, set CONNECT_TOKEN (+ CF_TOKEN, or TUNNEL_TOKEN + SANDBOX_HOSTNAME) directly.
#   CF_TOKEN       your Cloudflare API token (Zone:Read, DNS:Edit, Tunnel:Edit) — own-Cloudflare path only; it is
#                  NEVER sent to the platform and rides into the sandbox as CLOUDFLARE_API_TOKEN
#
# Platform statics (defaulted below — overridden only for local dev against a non-prod platform):
#   PLATFORM_URL         the platform base the setup code is redeemed against (default: https://app.intentic.dev)
#   GOOGLE_CLIENT_ID     the platform's PUBLIC Google web client id the daemon verifies sign-in against (default: hardcoded below)
#
# Optional env:
#   SANDBOX_IMAGE   sandbox image to run (default: the latest release registry.gitlab.com/radarsu/intentic/sandbox:stable)
#   PREVIEW_PORT    the daemon's preview-proxy port, exposed at preview-*.<zone> (default: 5173)
#   WEB_ORIGIN      scopes the daemon's CORS to the platform web app (default: open — the Google-token audience is the real gate)
#   ZONE            the Cloudflare zone to use when the token sees more than one
#   SELF_HOST       wire THIS machine as a deploy target (service user + SSH key + host SSH tunnel). DEFAULT OFF —
#                   setup is reachability-only. Set `SELF_HOST=1` (needs root, hence `sudo`) to register this
#                   machine as a deploy target; this is what the platform's "Deploy on this machine" action runs.
#   SELF_HOST_USER  the service user to create/use for self-host (default: intentic).
#   INSTALL_DOCKER  set to 1 to install Docker without the interactive consent prompt when it's missing.
#   SYNC_DIR + SYNC_PAIR_TOKEN  desktop sync chosen at setup: SYNC_DIR (the local folder) rides the command as
#                   an env var, SYNC_PAIR_TOKEN arrives via the setup-code claim; when SYNC_DIR is set, after the
#                   sandbox is up this script also runs the standard sync bootstrap (SYNC_SCRIPT_URL, default
#                   the published https://intentic.dev/sync — same source this script ships from) as the invoking
#                   user, so the one pasted command covers folder sync too. Never fatal to sandbox setup.
# POSIX sh (this is piped into `sh`, which is dash on Debian/Ubuntu/WSL — no `pipefail`).
set -eu

# The script curls the platform (setup-code claim) and Cloudflare; a box without curl would otherwise fail
# with a raw "command not found" mid-run (direct ./connect.sh runs — the piped form obviously has curl).
if ! command -v curl >/dev/null 2>&1; then
    echo "error: curl is required — install it and re-run." >&2
    exit 1
fi

# The one-liner passes the setup code positionally (`sh -s -- <CODE>`); SETUP_CODE env works for scripted runs.
# Optional flags: -y/--yes/--force skips the "you already have other sandboxes running" prompt (the old
# always-proceed behavior); -h/--help prints usage. The first non-flag positional is the setup code.
FORCE=0
_pos=""
while [ $# -gt 0 ]; do
    case "$1" in
        -y | --yes | --force) FORCE=1 ;;
        -h | --help)
            echo "intentic connect — run an intentic sandbox on this machine and expose it to your browser."
            echo "Usage: connect.sh [SETUP_CODE] [-y]"
            echo "  SETUP_CODE    code from the platform's setup screen (or set SETUP_CODE / CONNECT_TOKEN env)"
            echo "  -y, --yes     start without prompting even if other sandboxes are already running; alias --force"
            echo "  -h, --help    show this help"
            exit 0
            ;;
        --) shift; break ;;
        -*) echo "error: unknown flag '$1'." >&2; exit 2 ;;
        *) [ -n "$_pos" ] || _pos="$1" ;;
    esac
    shift
done
[ -n "$_pos" ] || _pos="${1:-}"
SETUP_CODE="${SETUP_CODE:-$_pos}"
# Where the sibling prompt's "remove some first" branch sends the user — the cleanup script this ships beside (its
# own picker handles the selection). Local ./connect.sh runs still hit the published cleanup, exactly as the sync
# bootstrap below defaults SYNC_SCRIPT_URL to the published sync.sh.
CLEANUP_SCRIPT_URL="${CLEANUP_SCRIPT_URL:-https://intentic.dev/cleanup}"
# The central platform is a single static domain (never self-hosted), so PLATFORM_URL defaults to it. It is only
# used to redeem the setup code at ${PLATFORM_URL}/setup/claim below. LOCAL DEV ONLY: to test against a platform
# running on your own machine, prepend PLATFORM_URL=http://localhost:<apiPort> — this is never shown in the
# product UI.
PLATFORM_URL="${PLATFORM_URL:-https://app.intentic.dev}"
CONNECT_TOKEN="${CONNECT_TOKEN:-}"
# The latest RELEASE image via the moving `stable` tag (pulled fresh below), never :latest: the release pipeline
# bumps every @intentic/* package to the release version, publishes them to npm, THEN builds this image and moves
# `stable` onto it — so its bundled CLI is a published version and the intent repo `intentic init` scaffolds
# (~<version>) resolves from npm. The continuous :latest / hand-tagged builds carry internal version 0.0.0
# (unpublished), so init's `pnpm install` fails and resolve can't find @intentic/graph. Unpinned on purpose — the
# release always moves `stable` to the newest release, so there's no tag+digest to bump here.
SANDBOX_IMAGE="${SANDBOX_IMAGE:-registry.gitlab.com/radarsu/intentic/sandbox:stable}"
# The daemon's preview proxy port, exposed at preview-*.<zone>; apps declare their own ports in apps.json.
PREVIEW_PORT="${PREVIEW_PORT:-5173}"
# Dev QoL: a named volume (or absolute host path) mounted at /agent-auth and passed as AGENT_AUTH_DIR, so the
# AI-provider OAuth stores (Claude/Codex/OpenCode) are shared across sandboxes and survive resets. A localhost
# platform injects it into the one-liner; cleanup.sh removes it only on explicit --agent-auth or an interactive
# opt-in, never as part of its default sweep. Empty (production) ⇒ credentials stay in the workspace volume.
INTENTIC_AGENT_AUTH_VOLUME="${INTENTIC_AGENT_AUTH_VOLUME:-}"
# Infra secrets `intentic apply` reads INSIDE the sandbox; they ride straight into the sandbox container's env
# and are never sent to the platform. CF_TOKEN (your Cloudflare API token) is REQUIRED — Cloudflare is intentic's
# reachability fabric (the tunnel that connects your services, exposes them, AND carries the browser→sandbox
# traffic); it is validated below and passed to the sandbox as the Cloudflare-standard CLOUDFLARE_API_TOKEN the
# CLI reads. HOST_SSH_KEY is optional (auto-generated when SELF_HOST wires this machine as a deploy target).
HOST_SSH_KEY="${HOST_SSH_KEY:-}"
CF_TOKEN="${CF_TOKEN:-}"
# Self-host: wire this machine as a deploy target (service user + SSH key + host SSH tunnel; needs root). DEFAULT
# OFF — setup only makes the sandbox reachable. The platform's "Deploy on this machine" action re-runs this with
# `SELF_HOST=1` (under `sudo`) to register the host as a deploy target so `intentic apply` can deploy onto it.
SELF_HOST="${SELF_HOST-}"
SELF_HOST_USER="${SELF_HOST_USER:-}"
# Browser-direct access: the sandbox is exposed at sandbox-<id>.<zone> via its OWN Cloudflare tunnel and the
# browser talks to it directly — the daemon verifies the user's Google ID token (audience = GOOGLE_CLIENT_ID, the
# platform's PUBLIC web client id, hardcoded here since it's a static platform value) and binds the owner on first
# connect (gated by CONNECT_TOKEN). WEB_ORIGIN, when set, scopes the daemon's CORS to the platform web app; left
# empty the daemon allows any origin (the Google-token audience is the real gate). ZONE picks the zone when the
# token sees several.
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-481795963975-cq9msl6higcd91joidrfp8mjlkuq5fk3.apps.googleusercontent.com}"
# The account email the platform seeds via the setup code; the daemon binds ONLY this Google identity as owner
# (empty on direct/headless runs ⇒ plain trust-on-first-use).
OWNER_EMAIL="${OWNER_EMAIL:-}"
WEB_ORIGIN="${WEB_ORIGIN:-}"
ZONE="${ZONE:-}"
CLOUDFLARED_IMAGE="${CLOUDFLARED_IMAGE:-cloudflare/cloudflared:2026.6.1}"
# The cloudflared binary version installed natively on a self-host to run its SSH-tunnel connector (matches
# the sidecar image tag). The connector must be native, not a container: under Docker Desktop a container's
# localhost is the VM, not this machine, so it could not reach the host's sshd at localhost:22.
CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-2026.6.1}"
# Public DNS the sandbox resolves through. `intentic apply` runs `cloudflared access tcp` inside the sandbox to
# reach enrolled hosts by their ssh-<id>.<zone> tunnel hostname; those records are minted moments before use, so
# the operator's own resolver often still has the pre-creation NXDOMAIN negatively cached (SOA min TTL) and the
# tunnel dial fails with a bare `read ECONNRESET`. A fresh public resolver (Cloudflare, where the zone lives)
# sidesteps that. Space-separated; set empty to keep Docker's default (restricted/split-horizon networks).
SANDBOX_DNS="${SANDBOX_DNS:-1.1.1.1 1.0.0.1}"
# The platform can PRE-PROVISION the tunnel (the intentic-provided path, for users with no Cloudflare of their
# own): it fills TUNNEL_TOKEN + SANDBOX_HOSTNAME into the one-liner INSTEAD of CF_TOKEN. When both are set we skip
# every Cloudflare API call and just run the sandbox + cloudflared with the given connector token — CF_TOKEN stays
# empty, so the sandbox gets no Cloudflare API token (reachability-only). SUBDOMAIN is the optional custom prefix
# for the self-provision (own-Cloudflare) path — sandbox-tunnel uses it in place of the derived sandbox-<id>.
TUNNEL_TOKEN="${TUNNEL_TOKEN:-}"
SANDBOX_HOSTNAME="${SANDBOX_HOSTNAME:-}"
SUBDOMAIN="${SUBDOMAIN:-}"
# Desktop sync chosen at setup (both ride the claim; env works for headless runs). The pair token is seeded into
# the sandbox at boot as a single-use pairing, then handed to the sync bootstrap fetched from SYNC_SCRIPT_URL.
SYNC_DIR="${SYNC_DIR:-}"
SYNC_PAIR_TOKEN="${SYNC_PAIR_TOKEN:-}"
SYNC_SCRIPT_URL="${SYNC_SCRIPT_URL:-https://intentic.dev/sync}"
SANDBOX_PUBLIC_URL=""
# The stable name the tunnel ingress dials. The workspace answers to it via a --network-alias on its own per-sandbox
# network, so the real container name stays unique (coexistence) while BOTH the platform-provisioned tunnel (whose
# ingress origin is fixed to this name) and the own-Cloudflare tunnel below reach the daemon by one constant.
ORIGIN_HOST="intentic-sandbox-workspace"

# Wire THIS machine as a deployable host: a dedicated service user in the docker group with a generated SSH key
# the sandbox uses to reach the host back over host.docker.internal. Idempotent — an existing user/key is reused
# so re-runs don't churn the key the platform pins. Needs root (uses `sudo -n` when not already root). Sets
# HOST_SSH_KEY (the generated private key) and SELF_HOST_USER, which ride into the sandbox container's env.
setup_self_host() {
    user="${SELF_HOST_USER:-intentic}"
    SELF_HOST_USER="$user"

    if [ "$(id -u)" = 0 ]; then
        SUDO=""
    elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
        SUDO="sudo -n"
    else
        echo "error: SELF_HOST setup needs root to create the '$user' user and authorize a key — re-run as root (sudo -i) or enable passwordless sudo." >&2
        exit 1
    fi
    if ! command -v useradd >/dev/null 2>&1; then
        echo "error: useradd not found — intentic self-host expects a standard Linux server (Debian/Ubuntu/RHEL)." >&2
        exit 1
    fi
    # Ensure an SSH server is installed and running — the sandbox deploys to this host over SSH. (Was a
    # warn-and-continue; a self-host with no sshd only failed later, deep inside `intentic apply`.)
    ensure_sshd

    if ! id "$user" >/dev/null 2>&1; then
        echo "intentic: creating service user '$user'…"
        $SUDO useradd -m -s /bin/bash "$user"
    fi
    # The host provider runs `docker version` over SSH, so the user needs docker access; group membership
    # applies to the sandbox's fresh SSH sessions. A missing docker group is a soft warning, not fatal.
    $SUDO usermod -aG docker "$user" 2>/dev/null || echo "intentic: warning — could not add '$user' to the docker group." >&2

    home="$(getent passwd "$user" | cut -d: -f6)"
    [ -n "$home" ] || home="/home/$user"
    ssh_dir="$home/.ssh"
    key="$ssh_dir/intentic_ed25519"
    auth="$ssh_dir/authorized_keys"
    $SUDO mkdir -p "$ssh_dir"
    # Generate once; reuse on re-runs so HOST_SSH_KEY (and the platform-pinned host key) stay stable.
    if ! $SUDO test -f "$key"; then
        echo "intentic: generating SSH key for '$user'…"
        $SUDO ssh-keygen -t ed25519 -N "" -C intentic-self-host -f "$key" >/dev/null
    fi
    # Authorize the public key for the service user (idempotent).
    pub="$($SUDO cat "$key.pub")"
    if ! $SUDO grep -qF "$pub" "$auth" 2>/dev/null; then
        echo "$pub" | $SUDO tee -a "$auth" >/dev/null
    fi
    $SUDO chown -R "$user:$user" "$ssh_dir"
    $SUDO chmod 700 "$ssh_dir"
    $SUDO chmod 600 "$auth" "$key"

    # Every provider writes its host state (each service's compose project + .env, the apply lock, secrets.json,
    # backup/restic state) under /opt/intentic, over SSH as this unprivileged user. /opt is root-owned, so the
    # providers cannot create it themselves — hand the dir to the user here. 700: it holds secrets and tokens.
    $SUDO mkdir -p /opt/intentic
    $SUDO chown "$user:$user" /opt/intentic
    $SUDO chmod 700 /opt/intentic

    # The sandbox reads HOST_SSH_KEY to authenticate as '$user' on host.docker.internal; ride it into the container.
    HOST_SSH_KEY="$($SUDO cat "$key")"
    echo "intentic: this server is registered as a deploy target (user '$user')."
}

# Ensure an SSH server is installed and listening on :22. The sandbox reaches it through this host's own
# Cloudflare tunnel (the connector below dials localhost:22), so sshd need not be exposed on any interface.
ensure_sshd() {
    if ! command -v sshd >/dev/null 2>&1 && [ ! -x /usr/sbin/sshd ]; then
        echo "intentic: installing OpenSSH server…"
        if command -v apt-get >/dev/null 2>&1; then
            $SUDO apt-get update -qq >/dev/null 2>&1 || true
            $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server >/dev/null
        elif command -v dnf >/dev/null 2>&1; then
            $SUDO dnf install -y -q openssh-server >/dev/null
        elif command -v yum >/dev/null 2>&1; then
            $SUDO yum install -y -q openssh-server >/dev/null
        elif command -v apk >/dev/null 2>&1; then
            $SUDO apk add --no-cache openssh >/dev/null
        else
            echo "error: no supported package manager (apt/dnf/yum/apk) to install openssh-server — install it and re-run." >&2
            exit 1
        fi
    fi
    # Host keys + the privilege-separation dir, then start sshd via whatever init is present.
    $SUDO ssh-keygen -A >/dev/null 2>&1 || true
    $SUDO mkdir -p /run/sshd 2>/dev/null || true
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        $SUDO systemctl enable --now ssh >/dev/null 2>&1 || $SUDO systemctl enable --now sshd >/dev/null 2>&1 || true
    elif command -v service >/dev/null 2>&1; then
        $SUDO service ssh start >/dev/null 2>&1 || $SUDO service sshd start >/dev/null 2>&1 || true
    fi
    # Force a listener on hosts without an init system (e.g. WSL without systemd): launch sshd directly.
    if ! (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':22 '; then
        $SUDO /usr/sbin/sshd >/dev/null 2>&1 || true
    fi
    if ! (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':22 '; then
        echo "intentic: warning — sshd does not appear to be listening on :22; the sandbox may not be able to deploy here." >&2
    fi
}

# Install the cloudflared binary natively on this host. Native (not a container) so its connector can reach
# the host's own sshd at localhost:22 — a container's localhost is the VM under Docker Desktop.
install_host_cloudflared() {
    if command -v cloudflared >/dev/null 2>&1; then
        return 0
    fi
    echo "intentic: installing cloudflared on this host…"
    arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
    case "$arch" in
        amd64 | x86_64) cf_arch="amd64" ;;
        arm64 | aarch64) cf_arch="arm64" ;;
        *)
            echo "error: unsupported architecture '$arch' for cloudflared; install it manually and re-run." >&2
            exit 1
            ;;
    esac
    $SUDO curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${cf_arch}" -o /usr/local/bin/cloudflared
    $SUDO chmod +x /usr/local/bin/cloudflared
}

# Run the host SSH-tunnel connector with its token. Prefer systemd for persistence (survives reboot);
# otherwise run detached (survives this script but not a reboot — re-run connect.sh after a reboot).
run_host_ssh_connector() {
    hst_token="$1"
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        {
            echo "[Unit]"
            echo "Description=intentic host SSH cloudflared connector"
            echo "After=network-online.target"
            echo "Wants=network-online.target"
            echo "[Service]"
            echo "ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token ${hst_token}"
            echo "Restart=always"
            echo "RestartSec=5"
            echo "[Install]"
            echo "WantedBy=multi-user.target"
        } | $SUDO tee /etc/systemd/system/intentic-host-ssh-tunnel.service >/dev/null
        $SUDO chmod 600 /etc/systemd/system/intentic-host-ssh-tunnel.service
        $SUDO systemctl daemon-reload
        $SUDO systemctl enable --now intentic-host-ssh-tunnel.service
    else
        $SUDO pkill -f "cloudflared tunnel --no-autoupdate run" >/dev/null 2>&1 || true
        $SUDO sh -c "nohup cloudflared tunnel --no-autoupdate run --token '${hst_token}' >/var/log/intentic-host-ssh-tunnel.log 2>&1 &"
        echo "intentic: the host SSH connector is running (detached; re-run connect.sh after a reboot to restore it)." >&2
    fi
}

# True if the image reference carries an explicit registry host — the part before the first `/` that looks
# like a hostname (contains a `.` or `:port`, or is `localhost`). A bare name like `intentic-sandbox:dev`
# has none (its `:` is the tag separator, not a port), so docker resolves it against Docker Hub.
image_has_registry() {
    case "$1" in
        */*) case "${1%%/*}" in *.*|*:*|localhost) return 0 ;; esac ;;
    esac
    return 1
}

# Make the sandbox image runnable, announcing which path it takes (the caller stays silent). A registry-less
# reference (dev override, e.g. SANDBOX_IMAGE=intentic-sandbox:dev) can only resolve to Docker Hub, so it is
# never pulled — that pull's "denied" output is pure noise. It is rebuilt from the checkout this script was
# run from on EVERY run, not just when missing: a cached image would otherwise silently outlive Dockerfile or
# source edits, and docker's layer cache makes an unchanged rebuild near-instant, so eager is the right default.
# (The dev one-liner is `sh _apps/site/public/scripts/connect.sh` at the repo root; the piped curl|sh form has
# no script path in $0 and thus no checkout — it runs an existing local image as-is, or errors.)
# Registry images are pulled even when cached so the moving `stable` tag always runs the newest release. The
# image is PUBLIC, so no login is needed — but a stale/expired `docker login registry.gitlab.com` (commonly
# left by Docker Desktop's credential store) makes docker present that token instead of pulling anonymously
# and the registry rejects the pull with "denied": on any pull failure, clear that login and retry once.
ensure_image() {
    image="$1"
    if ! image_has_registry "$image"; then
        # $0 carries a path only when the script was invoked by path (the dev flow); piped runs get no checkout.
        repo_root=""
        case "$0" in */*) repo_root="$(dirname "$0")/../../../.." ;; esac
        if [ -z "$repo_root" ] || [ ! -f "$repo_root/_apps/sandbox/Dockerfile" ]; then
            if docker image inspect "$image" >/dev/null 2>&1; then
                echo "intentic: using the existing local sandbox image ${image} (no intentic checkout found to rebuild it from)."
                return 0
            fi
            echo "intentic: '${image}' is a local dev tag that isn't built, and no intentic checkout was found to build it from — run 'pnpm build:sandbox' in the repo, or unset SANDBOX_IMAGE to use the published image." >&2
            return 1
        fi
        echo "intentic: building the local sandbox image ${image} from your checkout (cached when unchanged; the first build takes a few minutes)…"
        if docker build -f "$repo_root/_apps/sandbox/Dockerfile" -t "$image" "$repo_root"; then
            return 0
        fi
        if docker image inspect "$image" >/dev/null 2>&1; then
            echo "intentic: building ${image} failed (see the docker output above) — continuing with the PREVIOUS local build, which does NOT include your latest changes." >&2
            return 0
        fi
        echo "intentic: building ${image} failed (see the docker output above) — fix the build, or unset SANDBOX_IMAGE to use the published image." >&2
        return 1
    fi
    echo "intentic: pulling sandbox image ${image} (first run can take a minute)…"
    if docker pull "$image"; then
        return 0
    fi
    if docker image inspect "$image" >/dev/null 2>&1; then
        echo "intentic: pull failed but the image exists locally — using the local copy." >&2
        return 0
    fi
    echo "intentic: pull failed — clearing a stale registry.gitlab.com login and retrying anonymously…" >&2
    docker logout registry.gitlab.com >/dev/null 2>&1 || true
    docker pull "$image"
}

# Desktop sync (opted into at setup): wait for the daemon to answer INSIDE the container (a local check — no
# tunnel/DNS in the loop, so a slow DNS propagation can't fail or poison anything), then run the standard sync
# bootstrap AS THE INVOKING USER — the agent is per-user state (~/.intentic, ~/.ssh/config, the user's Mutagen
# daemon) and this script usually runs under sudo. The sync agent connects over the public URL, which may still
# be warming up at this point — its enrollment retries transient tunnel errors (see enrollKey), so this local
# gate need not wait for the tunnel. The caller wraps this in `if !` so any failure warns instead of killing a
# setup whose sandbox is already up.
run_desktop_sync() {
    if [ "$(id -u)" = 0 ]; then
        if [ -z "${SUDO_USER:-}" ]; then
            echo "intentic: skipping desktop sync — running as root with no invoking user to sync for." >&2
            return 1
        fi
        sync_user="sudo -u $SUDO_USER -H"
    else
        sync_user=""
    fi
    echo "intentic: waiting for your sandbox to come online to set up desktop sync…"
    i=0
    until docker exec "$CONTAINER" curl -fsS --max-time 5 localhost:8787/health >/dev/null 2>&1; do
        i=$((i + 1))
        [ "$i" -ge 60 ] && return 1
        sleep 3
    done
    # Fetch before piping — no pipefail under `set -eu`, so `curl | sh` would swallow a failed fetch.
    sync_script="$(curl -fsSL "$SYNC_SCRIPT_URL")" || return 1
    # $sync_user word-splits into `sudo -u <user> -H` on purpose (empty when not under sudo).
    printf '%s\n' "$sync_script" | $sync_user env SANDBOX_URL="$SANDBOX_PUBLIC_URL" PAIR_TOKEN="$SYNC_PAIR_TOKEN" SYNC_DIR="$SYNC_DIR" sh
}

# Consent gate for installing Docker: a root-level system change beyond the sandbox itself, so never silent.
# INSTALL_DOCKER=1 pre-consents (headless runs); otherwise ask on /dev/tty (the human is at a terminal even
# under `curl … | sh` — stdin is the script), and fail with the remedy when there is no terminal to ask.
confirm_install_docker() {
    if [ "${INSTALL_DOCKER:-}" = "1" ]; then
        return 0
    fi
    if [ ! -r /dev/tty ]; then
        echo "error: docker is not installed and there is no terminal to ask — re-run with INSTALL_DOCKER=1" >&2
        echo "       to install it automatically, or install it yourself: https://docs.docker.com/get-docker/" >&2
        exit 1
    fi
    printf '%s [Y/n] ' "$1" >&2
    read -r answer </dev/tty || answer=""
    case "$answer" in
        n* | N*)
            echo "error: docker is required — install it (https://docs.docker.com/get-docker/) and re-run." >&2
            exit 1
            ;;
    esac
}

# Docker Engine via Docker's official convenience script. Enabling dockerd on boot is also what brings the
# sandbox + tunnel containers (--restart unless-stopped) back after a reboot.
install_docker_linux() {
    confirm_install_docker "intentic: Docker is not installed. Install it now via get.docker.com?"
    if [ "$(id -u)" = 0 ]; then
        docker_sudo=""
    else
        docker_sudo="sudo"
    fi
    echo "intentic: installing Docker Engine (get.docker.com)…"
    curl -fsSL https://get.docker.com | $docker_sudo sh
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        $docker_sudo systemctl enable --now docker >/dev/null 2>&1 || true
    elif command -v service >/dev/null 2>&1; then
        $docker_sudo service docker start >/dev/null 2>&1 || true
    fi
}

# Docker Desktop, guided: its dmg ships a CLI installer, so under the one-liner's sudo this installs without
# clicking — only the first-run dialog stays manual (the daemon wait below covers it). --accept-license is
# passed only after the consent prompt above named Docker's terms. --user skips the privileged-helper prompt
# for the human who invoked sudo.
install_docker_macos() {
    confirm_install_docker "intentic: Docker Desktop is not installed. Download (~1.5 GB) and install it now? Continuing accepts Docker's terms (https://www.docker.com/legal/docker-subscription-service-agreement)."
    case "$(uname -m)" in
        arm64) dmg_arch="arm64" ;;
        *) dmg_arch="amd64" ;;
    esac
    dmg="$(mktemp -d)/Docker.dmg"
    echo "intentic: downloading Docker Desktop (~1.5 GB)…"
    curl -fL "https://desktop.docker.com/mac/main/${dmg_arch}/Docker.dmg" -o "$dmg"
    echo "intentic: installing Docker Desktop…"
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

echo "intentic: checking Docker…"
docker_installed=""
if ! command -v docker >/dev/null 2>&1; then
    case "$(uname -s)" in
        Linux) install_docker_linux ;;
        Darwin) install_docker_macos ;;
        *)
            echo "error: docker is not installed. Install Docker Desktop (https://docs.docker.com/get-docker/), then re-run." >&2
            exit 1
            ;;
    esac
    docker_installed=1
fi
# `docker info` aggregates CLI-plugin data and can hang (e.g. docker-scout/buildx); `docker version`
# with a server-format does a fast daemon round-trip and fails cleanly if the daemon is unreachable.
if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    if [ -z "$docker_installed" ]; then
        echo "error: the docker daemon is not running or not reachable. Start Docker, then re-run." >&2
        exit 1
    fi
    # A freshly installed daemon takes a moment (Docker Desktop: first-run dialog + VM boot) — wait up to 5 min.
    echo "intentic: waiting for the Docker daemon (accept Docker Desktop's first-run dialog if shown)…"
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

# The platform's one-liner carries ONE short-lived setup code instead of raw tokens (nothing secret lands in
# shell history or `ps`); redeem it for the per-sandbox values — CONNECT_TOKEN plus either the intentic tunnel
# token (provisioned by the platform during this claim) or the zone/subdomain picks (own-Cloudflare path, whose
# tunnel this script creates), as KEY=value lines. Env vars still
# work without a code (headless/scripted installs) — this block is simply skipped then. Redeemed after the
# Docker step so a docker-missing failure never burns time against the code's TTL.
if [ -n "$SETUP_CODE" ]; then
    echo "intentic: redeeming the setup code…"
    # LOCAL DEV ONLY: the dev platform's cert is a repo CA the system doesn't trust, so localhost claims skip
    # TLS verification — never for real domains.
    claim_opts=""
    case "$PLATFORM_URL" in
        *//localhost* | *//127.0.0.1*) claim_opts="-k" ;;
    esac
    claim="$(curl -fsS $claim_opts "$PLATFORM_URL/setup/claim" -d "code=$SETUP_CODE")" || {
        status=$?
        # Under -f, exit 22 is an HTTP error (the platform answered: bad/expired code); anything else is transport.
        if [ "$status" -eq 22 ]; then
            echo "error: the setup code is invalid or expired — refresh the platform's setup page and copy a fresh command." >&2
        else
            echo "error: could not reach the platform at $PLATFORM_URL to redeem the setup code (curl exit $status)." >&2
        fi
        exit 1
    }
    CONNECT_TOKEN="$(printf '%s\n' "$claim" | sed -n 's/^CONNECT_TOKEN=//p')"
    TUNNEL_TOKEN="$(printf '%s\n' "$claim" | sed -n 's/^TUNNEL_TOKEN=//p')"
    SANDBOX_HOSTNAME="$(printf '%s\n' "$claim" | sed -n 's/^SANDBOX_HOSTNAME=//p')"
    ZONE="$(printf '%s\n' "$claim" | sed -n 's/^ZONE=//p')"
    SUBDOMAIN="$(printf '%s\n' "$claim" | sed -n 's/^SUBDOMAIN=//p')"
    # SYNC_DIR is NOT claimed — it's the user's local folder opt-in, carried on the command as an env var.
    SYNC_PAIR_TOKEN="$(printf '%s\n' "$claim" | sed -n 's/^SYNC_PAIR_TOKEN=//p')"
    OWNER_EMAIL="$(printf '%s\n' "$claim" | sed -n 's/^OWNER_EMAIL=//p')"
fi
PROVIDED_TUNNEL=""
if [ -n "$TUNNEL_TOKEN" ] && [ -n "$SANDBOX_HOSTNAME" ]; then
    PROVIDED_TUNNEL=1
fi

# Per-sandbox identity, so several sandboxes coexist on one machine. The slug is the same key the public hostname
# uses: an explicit SUBDOMAIN, else a platform-provided hostname's leftmost label, else the connect-token digest
# that forms sandbox-<id>. So distinct tokens get distinct container/volume/network (which persist the cloned repos
# and let the tunnel ingress + cloudflared sidecar resolve by DNS), while re-running with the same token replaces
# just that one. sha256sum is coreutils on the Linux/WSL targets; shasum -a 256 is the macOS fallback.
if [ -n "$SUBDOMAIN" ]; then
    SLUG="$SUBDOMAIN"
elif [ -n "$PROVIDED_TUNNEL" ]; then
    SLUG="${SANDBOX_HOSTNAME%%.*}"
else
    SLUG="$(printf '%s' "$CONNECT_TOKEN" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-12)"
fi
CONTAINER="intentic-sandbox-${SLUG}"
WORKSPACE_VOLUME="intentic-workspace-${SLUG}"
# Snapshot history + protected repo git dirs live on their own volume, mounted OUTSIDE /work so agent accidents
# in the workspace can't destroy them.
HISTORY_VOLUME="intentic-history-${SLUG}"
# The in-sandbox Docker Engine's /var/lib/docker: a named volume so pulled images and dev-DB volumes survive
# recreates (rebuild/update/dev watch) — and layers land on a real filesystem (overlay2), not overlayfs-on-overlayfs.
DOCKER_VOLUME="intentic-docker-${SLUG}"
NETWORK="intentic-workspace-${SLUG}"
TUNNEL_CONTAINER="intentic-sandbox-tunnel-${SLUG}"

# ── coexistence check ─────────────────────────────────────────────────────────────────────────────────────────
# These helpers are duplicated in cleanup.sh (this script runs standalone via curl|sh, so it can't source a shared
# lib) — keep them in lockstep. Under curl|sh only STDIN is the pipe; interactive input must come from /dev/tty.
list_sandboxes() {
    docker ps -a --filter 'name=intentic-sandbox-' --format '{{.Names}}' 2>/dev/null \
        | grep -v '^intentic-sandbox-tunnel-' \
        | sed 's/^intentic-sandbox-//' || true
}
have_tty() { { true >/dev/tty; } 2>/dev/null; }
ask() {
    have_tty || return 1
    printf '%s' "$1" >/dev/tty
    IFS= read -r REPLY </dev/tty 2>/dev/null || return 1
}

# A machine can host several sandboxes at once (each suffixed by its own slug). If OTHER sandboxes already exist,
# don't silently start one more beside them — surface them and let the user continue, clean some up first, or quit.
# A same-slug re-run is a normal reset (replaces just that one), so the current slug is excluded. Skipped with -y;
# with no terminal to prompt on we proceed (an explicitly requested create must not block automation).
if [ "$FORCE" != 1 ]; then
    others="$(list_sandboxes | grep -vxF "$SLUG" || true)"
    if [ -n "$others" ]; then
        n="$(printf '%s\n' "$others" | grep -c . || true)"
        echo "intentic: you already have $n other sandbox(es) on this machine:"
        for s in $others; do
            st="$(docker inspect -f '{{.State.Status}}' "intentic-sandbox-$s" 2>/dev/null || echo '?')"
            printf '  %-9s %s\n' "$st" "$s"
        done
        if have_tty; then
            echo "This starts a NEW sandbox alongside them."
            echo "  [c] continue (start alongside)"
            echo "  [r] remove some first…"
            echo "  [q] quit"
            ask "Choose [c/r/q]: " || REPLY=q
            case "${REPLY:-}" in
                r | R)
                    echo "intentic: opening cleanup…"
                    curl -fsSL "$CLEANUP_SCRIPT_URL" | sh || true
                    echo "intentic: continuing with this sandbox…"
                    ;;
                q | Q | "")
                    echo "intentic: aborted — no sandbox started."
                    exit 0
                    ;;
                *) : ;; # c (or anything else) → start alongside
            esac
        else
            echo "intentic: no terminal to prompt — starting alongside them (pass -y to silence this, or run cleanup first)." >&2
        fi
    fi
fi

# Every connect leaves a log on this machine (docker run errors, launch health-check failures) — otherwise a
# failed setup is only ever seen on this terminal. Kept to the newest 10 connects; same dir rebuild.sh and the
# intentic CLI log to (keep the two scripts' log handling in lockstep).
LOG_DIR="${INTENTIC_LOG_DIR:-$HOME/.intentic/logs}"
mkdir -p "$LOG_DIR"
ls -1t "$LOG_DIR"/connect-*.log 2>/dev/null | tail -n +10 | xargs rm -f 2>/dev/null || true
LOG="$LOG_DIR/connect-$(date +%Y%m%d-%H%M%S).log"

# CONNECT_TOKEN is the per-user value the setup code redeems into (or env carries directly).
if [ -z "$CONNECT_TOKEN" ]; then
    echo "error: CONNECT_TOKEN is required (via the setup code or env) — copy the one-liner from the platform's setup screen." >&2
    exit 1
fi

# Intentic-provided sandboxes (pre-provisioned tunnel, no CF_TOKEN) can't wire SELF_HOST here — its host tunnel
# would need your OWN Cloudflare token. The Infra screen covers it instead: it mints an intentic-hosted host
# tunnel and hands you a connect-host one-liner (no Cloudflare token) to run on this machine. Fail fast rather
# than deep inside the host-tunnel step.
if [ -n "$PROVIDED_TUNNEL" ] && [ -n "$SELF_HOST" ]; then
    echo "error: SELF_HOST needs your own Cloudflare API token (CF_TOKEN). On an intentic-provided sandbox," >&2
    echo "       connect this machine from the workspace's Infra screen instead — its one-liner needs no" >&2
    echo "       Cloudflare token." >&2
    exit 1
fi

# Cloudflare is intentic's reachability fabric (the tunnel that connects services and exposes them), so the
# token is required and validated up front rather than failing later at `intentic apply`. The token never
# reaches the platform — it rides into the sandbox below. Verify it against Cloudflare's token-verify endpoint
# (the same Bearer/api.cloudflare.com auth intentic itself uses). `*: *true` tolerates compact or spaced JSON.
if [ -z "$PROVIDED_TUNNEL" ] && [ -z "$CF_TOKEN" ]; then
    echo "error: CF_TOKEN is required — Cloudflare is intentic's reachability fabric (the tunnel that" >&2
    echo "       connects your services and exposes them). Create a token at" >&2
    echo "       https://dash.cloudflare.com/profile/api-tokens with: Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit." >&2
    exit 1
fi
# Validate the token only when the user supplied one (own-Cloudflare path); the intentic-provided path has none.
# A network failure is reported as such — not conflated with a bad token.
if [ -n "$CF_TOKEN" ]; then
    echo "intentic: validating Cloudflare API token…"
    if ! cf_verify="$(curl -fsS -H "Authorization: Bearer $CF_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify 2>&1)"; then
        case "$cf_verify" in
            *401* | *403*) ;; # an auth error IS a bad token — fall through to the invalid-token message below
            *)
                echo "error: could not reach the Cloudflare API to validate the token: $cf_verify" >&2
                exit 1
                ;;
        esac
    fi
    if ! printf '%s' "$cf_verify" | grep -q '"success":[[:space:]]*true' || ! printf '%s' "$cf_verify" | grep -q '"status":[[:space:]]*"active"'; then
        echo "error: the Cloudflare API token is invalid or inactive (token verify failed). Re-check the token and its" >&2
        echo "       scopes (Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit) at https://dash.cloudflare.com/profile/api-tokens." >&2
        exit 1
    fi
fi

# Resolve the Cloudflare zone the sandbox tunnel lives under BEFORE the tunnel step, so a token that sees several
# zones gets a clear choice here instead of a bare "multiple zones" crash deep inside the CLI. The platform's
# setup screen normally pins ZONE already; this covers direct/CI runs (and any path that didn't set it). List the
# token's zones (same Bearer auth as the verify above) and parse "name":"…" with grep/sed — no jq on a stock box.
if [ -z "$PROVIDED_TUNNEL" ] && [ -z "$ZONE" ]; then
    echo "intentic: resolving the Cloudflare zone…"
    if ! zones_json="$(curl -fsS -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/zones?per_page=50" 2>&1)"; then
        echo "error: could not list Cloudflare zones: $zones_json" >&2
        exit 1
    fi
    zones="$(printf '%s' "$zones_json" | grep -o '"name":"[^"]*"' | sed 's/^"name":"//;s/"$//' || true)"
    zone_count="$(printf '%s\n' "$zones" | grep -c . || true)"
    if [ "$zone_count" -eq 0 ]; then
        echo "error: the Cloudflare API token sees no zones — add a domain to the account, or broaden the token's" >&2
        echo "       Zone:Read scope, at https://dash.cloudflare.com/profile/api-tokens, then re-run." >&2
        exit 1
    elif [ "$zone_count" -eq 1 ]; then
        ZONE="$zones"
        echo "intentic: using the only zone the token sees — $ZONE."
    elif [ -r /dev/tty ]; then
        # The human is at a terminal even under `curl … | sh` (stdin is the script), so prompt on /dev/tty.
        echo "intentic: this Cloudflare token can use several zones — pick the one your sandbox should use:" >&2
        i=1
        for z in $zones; do
            echo "  $i) $z" >&2
            i=$((i + 1))
        done
        printf "intentic: zone number [1]: " >&2
        read -r choice </dev/tty || choice=1
        [ -n "$choice" ] || choice=1
        case "$choice" in
            *[!0-9]*)
                echo "error: invalid selection '$choice'." >&2
                exit 1
                ;;
        esac
        ZONE="$(printf '%s\n' "$zones" | sed -n "${choice}p")"
        if [ -z "$ZONE" ]; then
            echo "error: '$choice' is out of range." >&2
            exit 1
        fi
        echo "intentic: using zone $ZONE."
    else
        # Non-interactive (no controlling terminal): can't prompt, so name the zones and the exact remedy.
        first="$(printf '%s\n' "$zones" | sed -n '1p')"
        echo "error: the Cloudflare API token sees multiple zones; set ZONE to choose one. The token can use:" >&2
        for z in $zones; do
            echo "  - $z" >&2
        done
        echo "       Re-run with ZONE set in the environment (alongside CF_TOKEN), e.g. ZONE=$first" >&2
        exit 1
    fi
fi

# When requested, wire this machine as a deploy target before starting the sandbox — sets HOST_SSH_KEY (the
# generated key) and SELF_HOST_USER, which ride into the sandbox container's env below.
if [ -n "$SELF_HOST" ]; then
    setup_self_host
fi

# Resolve the sandbox image up front (ensure_image prints its own progress) so a slow first pull/build
# doesn't look like a hang, a missing image surfaces as a clear error — and the tunnel step below, which runs
# this same image via `--entrypoint intentic`, never executes a stale locally-cached tag (docker run reuses a
# cached tag without re-pulling, so a republished image would otherwise be missed).
ensure_image "$SANDBOX_IMAGE"

# Point at the sandbox tunnel that exposes the daemon at sandbox-<id>.<zone> (:8787), plus the *.<zone> wildcard →
# the daemon's preview proxy (:$PREVIEW_PORT) on the own-Cloudflare path (the platform path instead mints a
# per-panel preview route when a panel starts). Either the platform pre-provisioned it with
# intentic's token (nothing to do here), or the bundled CLI creates/refreshes it with the user's token below and
# prints the connector token; cloudflared runs as a sidecar once the sandbox is up.
# Defined unconditionally so the host-ssh-tunnel step below (own-Cloudflare self-host) can reuse it too.
zone_env=""
[ -n "$ZONE" ] && zone_env="-e ZONE=$ZONE"
if [ -n "$PROVIDED_TUNNEL" ]; then
    # Intentic-provided path: the platform already created the tunnel + DNS with intentic's token and filled
    # TUNNEL_TOKEN + SANDBOX_HOSTNAME into the one-liner — nothing to do but record the public URL.
    SANDBOX_PUBLIC_URL="https://$SANDBOX_HOSTNAME"
else
    echo "intentic: creating the sandbox tunnel…"
    # An explicit subdomain (own-Cloudflare path) overrides the derived sandbox-<id>; validated as a DNS label
    # upstream, so it word-splits safely here (mirrors zone_env).
    sub_flag=""
    [ -n "$SUBDOMAIN" ] && sub_flag="--subdomain $SUBDOMAIN"
    # --entrypoint intentic: the image's default entrypoint is the daemon; we want the bundled CLI instead.
    tunnel_out="$(docker run --rm --entrypoint intentic \
        -e CLOUDFLARE_API_TOKEN="$CF_TOKEN" \
        -e CONNECT_TOKEN="$CONNECT_TOKEN" \
        $zone_env \
        "$SANDBOX_IMAGE" sandbox-tunnel \
        --service "http://${ORIGIN_HOST}:8787" \
        --preview-service "http://${ORIGIN_HOST}:${PREVIEW_PORT}" \
        --ssh-service "ssh://${ORIGIN_HOST}:22" \
        $sub_flag)"
    TUNNEL_TOKEN="$(printf '%s\n' "$tunnel_out" | sed -n 's/^TUNNEL_TOKEN=//p')"
    SANDBOX_HOSTNAME="$(printf '%s\n' "$tunnel_out" | sed -n 's/^SANDBOX_HOSTNAME=//p')"
    if [ -z "$TUNNEL_TOKEN" ] || [ -z "$SANDBOX_HOSTNAME" ]; then
        echo "error: failed to create the sandbox tunnel (see the output above)." >&2
        exit 1
    fi
    SANDBOX_PUBLIC_URL="https://$SANDBOX_HOSTNAME"
fi

# When self-hosting, expose THIS machine's sshd over its own Cloudflare tunnel so the sandbox can deploy to it
# through `cloudflared access` — a NAT'd local machine the sandbox can't reach by IP (e.g. Docker Desktop,
# where the sandbox only reaches host.docker.internal, which has no sshd). The sandbox is told to reach the
# self host this way via SELF_HOST_ADDRESS + SELF_HOST_VIA, set below and passed into its container.
SELF_HOST_ADDRESS=""
SELF_HOST_VIA=""
if [ -n "$SELF_HOST" ]; then
    echo "intentic: creating the host SSH tunnel…"
    host_ssh_out="$(docker run --rm --entrypoint intentic \
        -e CLOUDFLARE_API_TOKEN="$CF_TOKEN" \
        -e CONNECT_TOKEN="$CONNECT_TOKEN" \
        $zone_env \
        "$SANDBOX_IMAGE" host-ssh-tunnel)"
    HOST_SSH_TUNNEL_TOKEN="$(printf '%s\n' "$host_ssh_out" | sed -n 's/^HOST_SSH_TUNNEL_TOKEN=//p')"
    SELF_HOST_ADDRESS="$(printf '%s\n' "$host_ssh_out" | sed -n 's/^HOST_SSH_HOSTNAME=//p')"
    if [ -z "$HOST_SSH_TUNNEL_TOKEN" ] || [ -z "$SELF_HOST_ADDRESS" ]; then
        echo "error: failed to create the host SSH tunnel (see the output above)." >&2
        exit 1
    fi
    SELF_HOST_VIA="cloudflared"
    install_host_cloudflared
    run_host_ssh_connector "$HOST_SSH_TUNNEL_TOKEN"
    echo "intentic: this host's SSH is reachable through the tunnel at ${SELF_HOST_ADDRESS}."
fi

echo "intentic: starting sandbox…"
# cloudflared (the sidecar below) reaches the sandbox by container name on this shared network; create it first.
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# Tell the sandbox how to reach the self host: its tunnel hostname + transport. Unquoted so it expands to
# nothing when not self-hosting (leaving the daemon's host.docker.internal/direct defaults intact); the
# hostname has no spaces, so word-splitting is safe.
self_host_addr_env=""
[ -n "$SELF_HOST_ADDRESS" ] && self_host_addr_env="-e SELF_HOST_ADDRESS=$SELF_HOST_ADDRESS -e SELF_HOST_VIA=$SELF_HOST_VIA"

# The platform as seen FROM the container, for the daemon's announce (URL + liveness phone-home). A localhost
# dev platform is reachable from the container at host.docker.internal (mapped by --add-host below).
PLATFORM_URL_CONTAINER="$(printf '%s' "$PLATFORM_URL" | sed -e 's#//localhost#//host.docker.internal#' -e 's#//127\.0\.0\.1#//host.docker.internal#')"

# Runs PRIVILEGED with its own ISOLATED Docker Engine: the image bakes Docker + Compose and the daemon starts
# dockerd at boot, so `pnpm db:up` and `docker compose` work in the workspace out of the box. --privileged is
# what dockerd needs; the host's Docker socket is never mounted, so the agent's containers live inside the
# sandbox's own engine, not on the host daemon. (The vpn capability's /dev/net/tun + NET_ADMIN directives are
# subsumed by it.) --add-host lets the sandbox reach the host it runs on at host.docker.internal (SSH
# self-host deploys target it). The workspace volume persists the cloned repos across re-runs. The daemon binds
# 0.0.0.0:8787 on the private network; only the Cloudflare tunnel exposes it (no host port is published).
# GOOGLE_CLIENT_ID/CONNECT_TOKEN/WEB_ORIGIN activate the browser-facing auth; OWNER_EMAIL pins the owner the
# daemon will TOFU-bind (the account that created this sandbox); SANDBOX_PUBLIC_URL tells the daemon its own
# public address; PLATFORM_URL is where it announces that address + its liveness; CLOUDFLARE_API_TOKEN/HOST_SSH_KEY/
# SELF_HOST_USER are the infra secrets the in-sandbox `intentic apply` reads (they never touch the platform).
# NOTE: rebuild.sh replays this env set when recreating the sandbox from an approved overlay image — keep its
# allowlist in lockstep with the -e list here.
# The infra secrets ride in only when non-empty: a baked-in `CLOUDFLARE_API_TOKEN=""` would shadow the value
# the user later writes to the workspace .env (a container's env can't change after creation). Accumulated as
# argv via `set --` because HOST_SSH_KEY is a multi-line private key that must not word-split.
set --
for _dns in $SANDBOX_DNS; do set -- "$@" --dns "$_dns"; done
[ -n "$CF_TOKEN" ] && set -- "$@" -e CLOUDFLARE_API_TOKEN="$CF_TOKEN"
[ -n "$HOST_SSH_KEY" ] && set -- "$@" -e HOST_SSH_KEY="$HOST_SSH_KEY"
[ -n "$SELF_HOST_USER" ] && set -- "$@" -e SELF_HOST_USER="$SELF_HOST_USER"
[ -n "$INTENTIC_AGENT_AUTH_VOLUME" ] && set -- "$@" -v "${INTENTIC_AGENT_AUTH_VOLUME}:/agent-auth" -e AGENT_AUTH_DIR=/agent-auth
echo "== docker run ${SANDBOX_IMAGE} ==" >>"$LOG"
if ! docker run -d --init --privileged --restart unless-stopped --name "$CONTAINER" \
    --network "$NETWORK" \
    --network-alias "$ORIGIN_HOST" \
    --add-host host.docker.internal:host-gateway \
    --log-opt max-size=10m --log-opt max-file=3 \
    -v "${WORKSPACE_VOLUME}:/work" \
    -v "${HISTORY_VOLUME}:/history" \
    -v "${DOCKER_VOLUME}:/var/lib/docker" \
    -e WORKSPACE_ROOT="/work" \
    -e HISTORY_ROOT="/history" \
    -e SANDBOX_HOST="0.0.0.0" \
    -e SANDBOX_PORT="8787" \
    -e SANDBOX_NAME="$CONTAINER" \
    -e SANDBOX_IMAGE="$SANDBOX_IMAGE" \
    -e PREVIEW_PORT="$PREVIEW_PORT" \
    -e GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
    -e CONNECT_TOKEN="$CONNECT_TOKEN" \
    -e OWNER_EMAIL="$OWNER_EMAIL" \
    -e WEB_ORIGIN="$WEB_ORIGIN" \
    -e SANDBOX_PUBLIC_URL="$SANDBOX_PUBLIC_URL" \
    -e PLATFORM_URL="$PLATFORM_URL_CONTAINER" \
    -e SYNC_PAIR_TOKEN="$SYNC_PAIR_TOKEN" \
    "$@" \
    $self_host_addr_env \
    "$SANDBOX_IMAGE" >/dev/null 2>>"$LOG"; then
    tail -n 5 "$LOG" >&2
    echo "error: starting the sandbox failed — the full docker error is saved to ${LOG}." >&2
    exit 1
fi

# Start the tunnel connector: cloudflared on the shared network routes sandbox-<id>.<zone> → the daemon and
# the preview hostnames → the preview proxy. It retries until the sandbox is up, so ordering is not critical.
echo "intentic: starting the sandbox tunnel connector…"
docker rm -f "$TUNNEL_CONTAINER" >/dev/null 2>&1 || true
docker run -d --restart unless-stopped --name "$TUNNEL_CONTAINER" --network "$NETWORK" \
    --log-opt max-size=10m --log-opt max-file=3 \
    "$CLOUDFLARED_IMAGE" tunnel --no-autoupdate run --token "$TUNNEL_TOKEN" >/dev/null 2>>"$LOG"

# A container that starts but crash-loops would otherwise time out silently in the setup wizard — gate on the
# daemon's own /health before declaring success (lockstep with rebuild.sh's post-launch check).
echo "intentic: waiting for the sandbox daemon to come up…"
tries=0
until docker exec "$CONTAINER" curl -sf http://localhost:8787/health >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 15 ]; then
        echo "== container logs (${CONTAINER}) ==" >>"$LOG"
        docker logs --tail 500 "$CONTAINER" >>"$LOG" 2>&1 || true
        echo "error: the sandbox did not become healthy within 30s — its logs are saved to ${LOG}." >&2
        exit 1
    fi
    sleep 2
done

echo "intentic sandbox started."
echo "Your sandbox will be reachable at ${SANDBOX_PUBLIC_URL} (DNS may take a few seconds to propagate)."
echo "Return to the platform — your sandbox announces itself and setup continues automatically."

# Desktop sync chosen at setup: the same paste covers it, gated on the SYNC_DIR opt-in the command carried (the
# pair token is always claimed). Runs after the "return to the platform" lines — the wizard's live gate flips on
# the sandbox itself, independent of this stage — and never fails the setup.
if [ -n "$SYNC_DIR" ] && [ -n "$SYNC_PAIR_TOKEN" ]; then
    if ! run_desktop_sync; then
        echo "intentic: warning — desktop sync didn't finish. Your sandbox is fine; enable sync any time from the workspace's Desktop sync card." >&2
    fi
fi

if [ -z "$SELF_HOST" ]; then
    echo "Reachable only — no deploy target. To deploy an app onto this machine later, re-run with SELF_HOST=1 (needs sudo)."
fi
echo "Logs: docker logs -f ${CONTAINER} (connect logs: ${LOG_DIR})"
echo "Stop (keeps your /work): docker stop ${CONTAINER} ${TUNNEL_CONTAINER}"
echo "Reset this sandbox (also removes its /work volume): curl -fsSL https://intentic.dev/cleanup | sh -s -- ${SLUG} -y"
