#!/bin/sh
# intentic cleanup-host — remove EVERYTHING intentic put on THIS machine (a deploy target).
#
# The mirror of connect-host.sh plus what `intentic deploy apply` deployed here. It discovers the full local
# footprint, prints exactly what it found, asks once, then removes:
#   • every deployed container — the compose stacks under /opt/intentic (Komodo, SigNoz, backings, …) and
#     every intentic-stamped or intentic-named container (Forgejo, its runner, the tunnel connector, apps)
#   • those stacks' docker volumes — databases included
#   • /opt/intentic — all deployment state and secrets, INCLUDING the default on-host restic backup repo
#   • the host SSH tunnel connector (the intentic-host-ssh-tunnel systemd unit or the detached cloudflared)
#   • the service user connect-host created, with its home + SSH keys
# It does NOT uninstall shared software (Docker Engine, openssh-server, the cloudflared binary), and it
# CANNOT reach your Cloudflare account: this host's tunnels + DNS records (ssh-<id>.<zone>, the git/deploy/app
# hostnames) are owned by your sandbox — remove the server on the Infra screen and apply, or run
# `intentic deploy destroy` there, and the prune deletes them.
#
#   curl -fsSL https://intentic.dev/cleanup-host | sudo sh
#
# Optional:
#   CONFIRM=1     skip the interactive confirmation (headless runs)
#   HOST_USER     the service user connect-host created (default: intentic)
#   KEEP_USER=1   leave the service user + its home (and SSH keys) in place
# POSIX sh (piped into `sh`, which is dash on Debian/Ubuntu/WSL — no `pipefail`).
set -eu

HOST_USER="${HOST_USER:-intentic}"
STATE_DIR="/opt/intentic"
TUNNEL_UNIT="intentic-host-ssh-tunnel.service"
TUNNEL_LOG="/var/log/intentic-host-ssh-tunnel.log"
SUDO=""

# Cleanup removes system state (containers, a systemd unit, a user), so it needs root — same bar as connect-host.
if [ "$(id -u)" = 0 ]; then
    SUDO=""
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    SUDO="sudo -n"
else
    echo "error: cleanup-host needs root — re-run as root (sudo -i) or enable passwordless sudo." >&2
    exit 1
fi

have_docker=""
if command -v docker >/dev/null 2>&1 && docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    have_docker=1
fi

# ---- discover the footprint (read-only) ----

# Compose projects live one-per-dir under /opt/intentic (<dir name> = <project name>) with the compose.yaml
# the provider wrote — enough to `compose down -v` each without guessing.
projects=""
if [ -d "$STATE_DIR" ]; then
    for dir in "$STATE_DIR"/*/; do
        [ -f "${dir}compose.yaml" ] || continue
        projects="$projects $(basename "$dir")"
    done
fi

containers=""
volumes=""
if [ -n "$have_docker" ]; then
    # Stamped (intentic.id label), compose-project members (catches unstamped sidecars like Komodo's
    # postgres/ferretdb), and intentic-named singles (forgejo, runner, tunnel connector, backup, periphery).
    containers="$($SUDO docker ps -a --format '{{.Names}}' --filter label=intentic.id)"
    for project in $projects; do
        containers="$containers
$($SUDO docker ps -a --format '{{.Names}}' --filter "label=com.docker.compose.project=$project")"
        volumes="$volumes
$($SUDO docker volume ls -q --filter "label=com.docker.compose.project=$project")"
    done
    containers="$containers
$($SUDO docker ps -a --format '{{.Names}}' --filter 'name=^intentic-')"
    containers="$(printf '%s\n' "$containers" | grep -v '^$' | sort -u || true)"
    volumes="$(printf '%s\n' "$volumes" | grep -v '^$' | sort -u || true)"
fi

unit_present=""
if [ -f "/etc/systemd/system/$TUNNEL_UNIT" ]; then
    unit_present=1
fi

user_present=""
if id "$HOST_USER" >/dev/null 2>&1 && [ "${KEEP_USER:-}" != "1" ]; then
    user_present=1
fi

if [ -z "$containers" ] && [ -z "$volumes" ] && [ ! -d "$STATE_DIR" ] && [ -z "$unit_present" ] && [ -z "$user_present" ]; then
    echo "intentic: nothing to clean — no intentic footprint found on this machine."
    exit 0
fi

# ---- announce the plan, then confirm ----

echo "intentic: this will remove the following from THIS machine:"
if [ -n "$containers" ]; then
    echo "  containers ($(printf '%s\n' "$containers" | grep -c .)):"
    printf '%s\n' "$containers" | sed 's/^/    - /'
fi
if [ -n "$volumes" ]; then
    echo "  docker volumes ($(printf '%s\n' "$volumes" | grep -c .)) — databases included:"
    printf '%s\n' "$volumes" | sed 's/^/    - /'
fi
if [ -d "$STATE_DIR" ]; then
    echo "  $STATE_DIR — all deployment state + secrets, INCLUDING the on-host restic backup repo:"
    echo "    any backups stored only here are gone with it."
fi
if [ -n "$unit_present" ]; then
    echo "  the $TUNNEL_UNIT systemd unit (this host's SSH tunnel connector)"
fi
if [ -n "$user_present" ]; then
    echo "  the '$HOST_USER' service user, its home directory and SSH keys"
fi
echo "kept: Docker Engine, openssh-server, the cloudflared binary, pulled docker images."
echo "not reachable from here: this host's Cloudflare tunnels + DNS records — remove the server on the"
echo "Infra screen and apply (or run \`intentic deploy destroy\` in your sandbox) so the prune deletes them."

if [ "${CONFIRM:-}" != "1" ]; then
    # `-r /dev/tty` passes even where opening it fails (setsid/cron), so the read itself is the real probe:
    # a failed prompt means there is no terminal to ask on — say how to proceed instead of aborting mutely.
    printf 'intentic: remove all of the above? [y/N] ' >&2
    if ! read -r answer 2>/dev/null </dev/tty; then
        echo "" >&2
        echo "error: no terminal to confirm on — re-run with CONFIRM=1 to proceed non-interactively." >&2
        exit 1
    fi
    case "$answer" in
        y* | Y*) ;;
        *)
            echo "intentic: aborted — nothing was removed."
            exit 0
            ;;
    esac
fi

# ---- remove ----

if [ -n "$have_docker" ]; then
    for project in $projects; do
        echo "intentic: tearing down the '$project' stack…"
        $SUDO docker compose -p "$project" --project-directory "$STATE_DIR/$project" \
            --env-file "$STATE_DIR/$project/.env" -f "$STATE_DIR/$project/compose.yaml" down -v 2>/dev/null ||
            true
    done
    if [ -n "$containers" ]; then
        echo "intentic: removing the remaining containers…"
        # shellcheck disable=SC2086 — container names are newline-separated words with no spaces.
        printf '%s\n' "$containers" | while read -r name; do
            [ -n "$name" ] || continue
            $SUDO docker rm -f "$name" >/dev/null 2>&1 || true
        done
    fi
    if [ -n "$volumes" ]; then
        echo "intentic: removing the docker volumes…"
        printf '%s\n' "$volumes" | while read -r volume; do
            [ -n "$volume" ] || continue
            $SUDO docker volume rm -f "$volume" >/dev/null 2>&1 || true
        done
    fi
elif [ -n "$projects" ]; then
    echo "intentic: warning — docker is not running, so deployed containers/volumes could not be removed." >&2
fi

if [ -n "$unit_present" ]; then
    echo "intentic: removing the host SSH tunnel connector…"
    $SUDO systemctl disable --now "$TUNNEL_UNIT" >/dev/null 2>&1 || true
    $SUDO rm -f "/etc/systemd/system/$TUNNEL_UNIT"
    $SUDO systemctl daemon-reload >/dev/null 2>&1 || true
fi
# The non-systemd fallback ran cloudflared detached; stop it either way.
$SUDO pkill -f "cloudflared tunnel --no-autoupdate run" >/dev/null 2>&1 || true
$SUDO rm -f "$TUNNEL_LOG"

if [ -d "$STATE_DIR" ]; then
    echo "intentic: removing $STATE_DIR…"
    $SUDO rm -rf "$STATE_DIR"
fi

if [ -n "$user_present" ]; then
    echo "intentic: removing the '$HOST_USER' service user…"
    $SUDO pkill -u "$HOST_USER" >/dev/null 2>&1 || true
    $SUDO userdel -r "$HOST_USER" >/dev/null 2>&1 || $SUDO userdel "$HOST_USER" || true
fi

echo "intentic: done — this machine no longer runs anything intentic put on it."
echo "Reclaim image disk space with \`docker image prune -a\` if you want it back."
