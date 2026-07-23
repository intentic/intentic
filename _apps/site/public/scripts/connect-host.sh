#!/bin/sh
# intentic connect-host — enroll THIS machine as a deploy target for an existing intentic sandbox.
#
# Run it on any host you want intentic to deploy onto — the sandbox's OWN machine or another one; run it on as
# many machines as you like (intentic splits your services across them). It creates a dedicated service user +
# SSH key, exposes this host's sshd over its OWN Cloudflare tunnel (ssh-<id>.<zone>), and self-registers with
# your sandbox's daemon via POST /enroll (authenticated by your connection token). It does NOT create or
# recreate a sandbox — that already exists from setup.
#
# Two paths, matching the sandbox's setup mode (the Infra screen hands you the right one-liner):
#   own Cloudflare — CF_TOKEN creates this host's tunnel + DNS on your zone:
#     curl -fsSL https://intentic.dev/connect-host \
#       | sudo env SANDBOX_URL=… CONNECT_TOKEN=… CF_TOKEN=… ZONE=… HOST_NAME=… sh
#   intentic-provided — the platform already minted the tunnel under intentic's zone; the command carries its
#   narrow connector token instead of a Cloudflare token (no tunnel creation here):
#     curl -fsSL https://intentic.dev/connect-host \
#       | sudo env SANDBOX_URL=… CONNECT_TOKEN=… HOST_SSH_TUNNEL_TOKEN=… HOST_SSH_HOSTNAME=… HOST_NAME=… sh
#
# Required:
#   SANDBOX_URL    your sandbox's public URL (https://sandbox-<id>.<zone>); the script POSTs $SANDBOX_URL/enroll
#   CONNECT_TOKEN  your per-user connection token (authorizes /enroll; also salts this host's tunnel id)
#   CF_TOKEN       your Cloudflare API token (Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit) — creates the host
#                  tunnel; not needed (and unused) when a pre-provisioned tunnel is supplied
# Pre-provisioned tunnel (both together; minted by the Infra screen for intentic-provided sandboxes):
#   HOST_SSH_TUNNEL_TOKEN  the tunnel's cloudflared connector token
#   HOST_SSH_HOSTNAME      its public hostname (ssh-<id>.<zone>); becomes the host's registered address
#                          — HOST_NAME is then required: it salted the minted tunnel id on the Infra screen
# Optional:
#   ZONE                 Cloudflare zone (when the token sees several)
#   HOST_NAME            inventory name for this host (default: this machine's hostname, sanitized)
#   HOST_USER            the service user to create/use (default: intentic)
#   SANDBOX_IMAGE        the image carrying the intentic CLI for the tunnel step (default: the latest release)
#   CLOUDFLARED_VERSION  the native cloudflared version for the host connector
#   INSTALL_DOCKER       set to 1 to install Docker without the interactive consent prompt when it's missing
# POSIX sh (piped into `sh`, which is dash on Debian/Ubuntu/WSL — no `pipefail`).
set -eu

# The script curls Cloudflare and the sandbox's /enroll; fail up front on a box without curl.
if ! command -v curl >/dev/null 2>&1; then
    echo "error: curl is required — install it and re-run." >&2
    exit 1
fi

SANDBOX_URL="${SANDBOX_URL:-}"
CONNECT_TOKEN="${CONNECT_TOKEN:-}"
CF_TOKEN="${CF_TOKEN:-}"
ZONE="${ZONE:-}"
HOST_SSH_TUNNEL_TOKEN="${HOST_SSH_TUNNEL_TOKEN:-}"
HOST_SSH_HOSTNAME="${HOST_SSH_HOSTNAME:-}"
HOST_USER="${HOST_USER:-intentic}"
SANDBOX_IMAGE="${SANDBOX_IMAGE:-registry.gitlab.com/radarsu/intentic/sandbox:stable}"
CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-2026.7.2}"
HOST_SSH_KEY=""
SUDO=""

# Pre-provisioned host tunnel (intentic-provided sandboxes): the platform minted the tunnel + DNS under its own
# zone and the one-liner carries the connector token + hostname — no Cloudflare token, no tunnel creation here.
PROVIDED_TUNNEL=""
if [ -n "$HOST_SSH_TUNNEL_TOKEN" ] && [ -n "$HOST_SSH_HOSTNAME" ]; then
    PROVIDED_TUNNEL=1
fi

# HOST_NAME is normalized to a valid deploy.config identifier (^[a-zA-Z_]\w*$): lower-cased, trimmed,
# non-alnum/underscore -> `_`; a leading digit is prefixed with `_`; "self" is reserved (legacy HOST_SSH_KEY), -> host.
normalize_host_name() {
    h="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/[^a-z0-9_]/_/g')"
    if [ -z "$h" ]; then
        printf ''
        return 0
    fi
    case "$h" in [0-9]*) h="_$h" ;; esac
    [ "$h" != "self" ] || h="host"
    printf '%s' "$h"
}

default_host_name() {
    h="$(normalize_host_name "$(hostname 2>/dev/null || printf '')")"
    [ -n "$h" ] || h="host"
    printf '%s' "$h"
}
# The pre-provisioned path requires an explicit HOST_NAME: the minted tunnel id is salted with the name picked
# on the Infra screen, so a machine-hostname default here would silently desync from it.
if [ -n "$PROVIDED_TUNNEL" ] && [ -z "${HOST_NAME:-}" ]; then
    echo "error: HOST_NAME is required with a pre-provisioned tunnel — copy the one-liner from the Infra screen." >&2
    exit 1
fi
if [ -n "${HOST_NAME:-}" ]; then
    HOST_NAME="$(normalize_host_name "$HOST_NAME")"
else
    HOST_NAME="$(default_host_name)"
fi
if [ -z "$HOST_NAME" ]; then
    if [ -n "$PROVIDED_TUNNEL" ]; then
        echo "error: HOST_NAME could not be normalized to a deploy target id — copy the one-liner from the Infra screen." >&2
        exit 1
    fi
    HOST_NAME="$(default_host_name)"
fi

# Enrollment mutates the host (creates a user, installs packages), so it needs root. Prefer already-root, else
# passwordless sudo; otherwise stop with a clear message (rather than failing deep in a package install).
require_root() {
    if [ "$(id -u)" = 0 ]; then
        SUDO=""
    elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
        SUDO="sudo -n"
    else
        echo "error: connect-host needs root to create the '$HOST_USER' user + authorize a key — re-run as root (sudo -i) or enable passwordless sudo." >&2
        exit 1
    fi
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
    $SUDO ssh-keygen -A >/dev/null 2>&1 || true
    $SUDO mkdir -p /run/sshd 2>/dev/null || true
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        $SUDO systemctl enable --now ssh >/dev/null 2>&1 || $SUDO systemctl enable --now sshd >/dev/null 2>&1 || true
    elif command -v service >/dev/null 2>&1; then
        $SUDO service ssh start >/dev/null 2>&1 || $SUDO service sshd start >/dev/null 2>&1 || true
    fi
    if ! (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':22 '; then
        $SUDO /usr/sbin/sshd >/dev/null 2>&1 || true
    fi
    if ! (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':22 '; then
        echo "intentic: warning — sshd does not appear to be listening on :22; the sandbox may not be able to deploy here." >&2
    fi
}

# Create the deploy service user (docker group) + a stable ed25519 key, authorize it, and capture the PRIVATE
# half into HOST_SSH_KEY (posted to the sandbox's /enroll → its .env). Idempotent — an existing user/key is reused.
setup_host() {
    if ! command -v useradd >/dev/null 2>&1; then
        echo "error: useradd not found — intentic expects a standard Linux server (Debian/Ubuntu/RHEL)." >&2
        exit 1
    fi
    ensure_sshd
    if ! id "$HOST_USER" >/dev/null 2>&1; then
        echo "intentic: creating service user '$HOST_USER'…"
        $SUDO useradd -m -s /bin/bash "$HOST_USER"
    fi
    $SUDO usermod -aG docker "$HOST_USER" 2>/dev/null || echo "intentic: warning — could not add '$HOST_USER' to the docker group." >&2

    home="$(getent passwd "$HOST_USER" | cut -d: -f6)"
    [ -n "$home" ] || home="/home/$HOST_USER"
    ssh_dir="$home/.ssh"
    key="$ssh_dir/intentic_ed25519"
    auth="$ssh_dir/authorized_keys"
    $SUDO mkdir -p "$ssh_dir"
    if ! $SUDO test -f "$key"; then
        echo "intentic: generating SSH key for '$HOST_USER'…"
        $SUDO ssh-keygen -t ed25519 -N "" -C intentic-host -f "$key" >/dev/null
    fi
    pub="$($SUDO cat "$key.pub")"
    if ! $SUDO grep -qF "$pub" "$auth" 2>/dev/null; then
        echo "$pub" | $SUDO tee -a "$auth" >/dev/null
    fi
    $SUDO chown -R "$HOST_USER:$HOST_USER" "$ssh_dir"
    $SUDO chmod 700 "$ssh_dir"
    $SUDO chmod 600 "$auth" "$key"

    # Every provider writes its host state (each service's compose project + .env, the apply lock, secrets.json,
    # backup/restic state) under /opt/intentic, over SSH as this unprivileged user. /opt is root-owned, so the
    # providers cannot create it themselves — hand the dir to the user here. 700: it holds secrets and tokens.
    $SUDO mkdir -p /opt/intentic
    $SUDO chown "$HOST_USER:$HOST_USER" /opt/intentic
    $SUDO chmod 700 /opt/intentic

    HOST_SSH_KEY="$($SUDO cat "$key")"
    echo "intentic: registered '$HOST_USER' on this host as deploy target \"$HOST_NAME\"."
}

# Install cloudflared natively (not a container: a container's localhost is the VM under Docker Desktop, not the host).
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

# Run the host SSH-tunnel connector. Prefer systemd (survives reboot); else detached (re-run after a reboot).
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
        echo "intentic: the host SSH connector is running (detached; re-run connect-host.sh after a reboot to restore it)." >&2
    fi
}

# Pull a published image, clearing a stale registry.gitlab.com login and retrying anonymously on failure (the image is public).
pull_image() {
    image="$1"
    if docker pull "$image"; then
        return 0
    fi
    echo "intentic: pull failed — clearing a stale registry.gitlab.com login and retrying anonymously…" >&2
    docker logout registry.gitlab.com >/dev/null 2>&1 || true
    docker pull "$image"
}

# ---- preflight ----
require_root
echo "intentic: checking Docker…"
docker_installed=""
if ! command -v docker >/dev/null 2>&1; then
    # Deploy targets are standard Linux servers, so install Docker Engine via Docker's official convenience
    # script — with consent (a root-level system change), pre-given via INSTALL_DOCKER=1 for headless runs.
    if [ "${INSTALL_DOCKER:-}" != "1" ]; then
        if [ ! -r /dev/tty ]; then
            echo "error: docker is not installed and there is no terminal to ask — re-run with INSTALL_DOCKER=1" >&2
            echo "       to install it automatically, or install it yourself: https://docs.docker.com/engine/install/" >&2
            exit 1
        fi
        printf 'intentic: Docker is not installed. Install it now via get.docker.com? [Y/n] ' >&2
        read -r answer </dev/tty || answer=""
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
    docker_installed=1
fi
if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    if [ -z "$docker_installed" ]; then
        echo "error: the docker daemon is not running or not reachable. Start Docker, then re-run." >&2
        exit 1
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
# CF_TOKEN only creates the host tunnel — a pre-provisioned one makes it unnecessary.
required_vars="SANDBOX_URL CONNECT_TOKEN"
[ -n "$PROVIDED_TUNNEL" ] || required_vars="$required_vars CF_TOKEN"
for var in $required_vars; do
    eval "val=\${$var}"
    if [ -z "$val" ]; then
        echo "error: $var is required — copy the one-liner from the Infra screen." >&2
        exit 1
    fi
done

# Validate the Cloudflare token up front (same verify endpoint intentic uses), then resolve the zone if unset.
# A network failure is reported as such — not conflated with a bad token. The pre-provisioned path skips both:
# there is no token, and the hostname (with its zone) was already minted.
if [ -z "$PROVIDED_TUNNEL" ]; then
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
        echo "error: the Cloudflare API token is invalid or inactive. Re-check it + its scopes (Zone:Read, DNS:Edit, Cloudflare Tunnel:Edit)." >&2
        exit 1
    fi
    if [ -z "$ZONE" ]; then
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
            echo "intentic: this Cloudflare token can use several zones — pick the one this host's tunnel should use:" >&2
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
fi

# ---- enroll ----
setup_host
echo "intentic: pulling the intentic CLI image (${SANDBOX_IMAGE})…"
pull_image "$SANDBOX_IMAGE"

if [ -n "$PROVIDED_TUNNEL" ]; then
    echo "intentic: using the pre-provisioned host SSH tunnel ($HOST_SSH_HOSTNAME)."
    HOST_ADDRESS="$HOST_SSH_HOSTNAME"
else
    echo "intentic: creating this host's SSH tunnel…"
    zone_env=""
    [ -n "$ZONE" ] && zone_env="-e ZONE=$ZONE"
    host_ssh_out="$(docker run --rm --entrypoint intentic \
        -e CLOUDFLARE_API_TOKEN="$CF_TOKEN" \
        -e CONNECT_TOKEN="$CONNECT_TOKEN" \
        -e HOST_NAME="$HOST_NAME" \
        $zone_env \
        "$SANDBOX_IMAGE" host-ssh-tunnel)"
    HOST_SSH_TUNNEL_TOKEN="$(printf '%s\n' "$host_ssh_out" | sed -n 's/^HOST_SSH_TUNNEL_TOKEN=//p')"
    HOST_ADDRESS="$(printf '%s\n' "$host_ssh_out" | sed -n 's/^HOST_SSH_HOSTNAME=//p')"
    if [ -z "$HOST_SSH_TUNNEL_TOKEN" ] || [ -z "$HOST_ADDRESS" ]; then
        echo "error: failed to create this host's SSH tunnel (see the output above)." >&2
        exit 1
    fi
fi
install_host_cloudflared
run_host_ssh_connector "$HOST_SSH_TUNNEL_TOKEN"

# JSON-encode the multi-line private key with the image's node (no jq on a stock box), then POST /enroll.
# cfToken rides along only on the own-Cloudflare path — the pre-provisioned one has no token to hand over.
echo "intentic: enrolling with the sandbox…"
key_json="$(docker run --rm --entrypoint node -e K="$HOST_SSH_KEY" "$SANDBOX_IMAGE" -e 'process.stdout.write(JSON.stringify(process.env.K))')"
cf_json=""
if [ -n "$CF_TOKEN" ]; then
    # ZONE is always resolved by now on the own-Cloudflare path (single zone auto-picked, several prompted).
    cf_json=",\"cfToken\":\"$CF_TOKEN\",\"cfZone\":\"$ZONE\""
fi
body="{\"name\":\"$HOST_NAME\",\"user\":\"$HOST_USER\",\"address\":\"$HOST_ADDRESS\",\"port\":22,\"via\":\"cloudflared\",\"sshKey\":$key_json$cf_json}"
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SANDBOX_URL/enroll" \
    -H "x-intentic-connect: $CONNECT_TOKEN" -H "content-type: application/json" -d "$body" || echo "000")"
if [ "$code" != "200" ]; then
    echo "error: enroll failed (HTTP $code). Is the sandbox reachable at $SANDBOX_URL and is the DevOps capability active?" >&2
    exit 1
fi

echo "intentic: this machine is enrolled as deploy target \"$HOST_NAME\" (SSH reachable at $HOST_ADDRESS)."
echo "Provision from the Infra screen to deploy onto it. Re-run this script anytime to refresh the key/tunnel."
