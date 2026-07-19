#!/bin/sh
# intentic cleanup — remove intentic sandboxes' Docker footprint on THIS machine, INCLUDING the named /work volumes.
#
# Why this exists: a sandbox's /work is a NAMED Docker volume (intentic-workspace-<slug>). `docker rm -v` and
# lazydocker's "remove with volumes" only prune ANONYMOUS volumes — a named volume survives every container remove,
# so a stale /work persists across re-runs and the daemon's boot gate then skips re-scaffolding. This removes the
# containers AND the named volumes AND the networks. It deliberately leaves the platform's own resources
# (intentic-app-*) untouched.
#
# A machine can host several sandboxes at once (each is suffixed by its <slug>). By DEFAULT this lists them and lets
# you PICK which to remove — it never wipes everything unless you ask. Removing a sandbox DELETES its data (/work +
# /history), so every removal is confirmed unless you pass -y.
#
# The shared dev agent-auth volume (connect.sh's INTENTIC_AGENT_AUTH_VOLUME — the AI-provider OAuth logins for ALL
# dev sandboxes) survives cleanup by default: pass --agent-auth to remove it too, or answer the interactive question
# offered once the last sandbox is gone. -y alone never removes it.
#
# Usage:
#   curl -fsSL https://intentic.dev/cleanup | sh                 # pick which sandbox(es) to remove (interactive)
#   curl -fsSL https://intentic.dev/cleanup | sh -s -- SLUG      # remove one sandbox by slug
#   curl -fsSL https://intentic.dev/cleanup | sh -s -- --all     # remove EVERY sandbox
#   curl -fsSL https://intentic.dev/cleanup | sh -s -- --all -y  # …skip the confirm (scripts/CI)
#   ./_apps/site/public/scripts/cleanup.sh [SLUG...] [--all] [-y] [--agent-auth]
#
# Non-interactive runs (no terminal, e.g. a bare pipe with no controlling tty) NEVER auto-remove: they print the
# list and exit. Pass a SLUG or --all to act.
#
# NOT removed (host-level, only exist after a SELF_HOST=1 run; recreated on the next one): the
# `intentic-host-ssh-tunnel` systemd unit, the natively-installed cloudflared, and the `intentic` service user.
# Remove them by hand if you want a full teardown:
#   sudo systemctl disable --now intentic-host-ssh-tunnel.service; sudo rm -f /etc/systemd/system/intentic-host-ssh-tunnel.service
#   sudo userdel -r intentic
# POSIX sh (this is piped into `sh`, which is dash on Debian/Ubuntu/WSL — no `pipefail`).
set -eu

if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is not installed — nothing to clean up." >&2
    exit 1
fi

usage() {
    echo "intentic cleanup — remove sandbox(es) on this machine (containers + named /work volumes + networks)."
    echo "Usage: cleanup.sh [SLUG...] [--all] [-y] [--agent-auth]"
    echo "  (no arg)      pick which sandbox(es) to remove (interactive); non-interactive runs list and stop"
    echo "  SLUG...       remove the named sandbox(es)"
    echo "  -a, --all     remove EVERY sandbox on this machine"
    echo "  -y, --yes     skip confirmation prompts (scripts/CI); alias --force"
    echo "  --agent-auth  also remove the shared dev agent-auth volume (AI logins for ALL dev sandboxes)"
    echo "  -h, --help    show this help"
}

# ── shared helpers ────────────────────────────────────────────────────────────────────────────────────────────
# NOTE: this script is fetched and run standalone (curl … | sh), so it can't source a shared lib — these helpers are
# duplicated in connect.sh. Keep the two in lockstep. Under curl|sh only STDIN is the pipe: stdout/stderr are the
# terminal (plain echo is fine) but interactive input must come from /dev/tty, not stdin.

# Distinct sandbox slugs on this machine — the primary containers only (the -tunnel- sidecar shares the prefix).
list_sandboxes() {
    docker ps -a --filter 'name=intentic-sandbox-' --format '{{.Names}}' 2>/dev/null \
        | grep -v '^intentic-sandbox-tunnel-' \
        | sed 's/^intentic-sandbox-//' || true
}

# True when a controlling terminal is available to prompt on (false under a bare no-tty pipe / CI).
have_tty() { { true >/dev/tty; } 2>/dev/null; }

# Prompt on the tty and read one line into REPLY. Returns non-zero (never aborting under set -e) if there's no tty.
ask() {
    have_tty || return 1
    printf '%s' "$1" >/dev/tty
    IFS= read -r REPLY </dev/tty 2>/dev/null || return 1
}

# yes/no confirmation, default NO. Honors -y (FORCE). Returns 0 for yes.
confirm() {
    [ "$FORCE" = 1 ] && return 0
    ask "$1 [y/N] " || return 1
    case "$REPLY" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# The Nth word (1-based) of the remaining args: `nth 2 a b c` -> b.
nth() { _n="$1"; shift; while [ "$_n" -gt 1 ]; do shift; _n=$((_n - 1)); done; printf '%s' "$1"; }

# Remove one sandbox by slug: its 3 containers, 4 named volumes, and network. Idempotent (missing = no-op).
remove_slug() {
    s="$1"
    echo "intentic: removing sandbox '$s' (containers + named volumes + network)…"
    for c in "intentic-sandbox-$s" "intentic-sandbox-tunnel-$s" "intentic-dind-host-$s"; do
        docker rm -f "$c" >/dev/null 2>&1 || true
    done
    for v in "intentic-workspace-$s" "intentic-history-$s" "intentic-docker-$s" "intentic-dind-docker-$s"; do
        docker volume rm "$v" >/dev/null 2>&1 || true
    done
    docker network rm "intentic-workspace-$s" >/dev/null 2>&1 || true
}

# Remove EVERY sandbox by name prefix (also sweeps orphaned volumes/networks a per-slug pass would miss). Prefixes
# never overlap the platform's intentic-app-* resources.
remove_all() {
    echo "intentic: removing sandbox containers…"
    for c in $(docker ps -aq --filter 'name=intentic-sandbox-'; docker ps -aq --filter 'name=intentic-dind-host-'); do
        docker rm -f "$c" >/dev/null 2>&1 || true
    done
    # `docker rm -v` prunes only ANONYMOUS volumes; the named /work volume must be removed explicitly.
    echo "intentic: removing named volumes (the persistent /work)…"
    for v in $(docker volume ls -q --filter 'name=intentic-workspace-'; docker volume ls -q --filter 'name=intentic-history-'; docker volume ls -q --filter 'name=intentic-docker-'; docker volume ls -q --filter 'name=intentic-dind-docker-'); do
        docker volume rm "$v" >/dev/null 2>&1 || true
    done
    echo "intentic: removing sandbox network(s)…"
    for n in $(docker network ls -q --filter 'name=intentic-workspace-'); do
        docker network rm "$n" >/dev/null 2>&1 || true
    done
}

# Host-side desktop-sync state (per-user: ~/.intentic/sync, the ~/.ssh/config Include, the Mutagen session +
# daemon registration) — removed as the INVOKING user, mirroring how connect.sh installed it. This is host/desktop-
# wide, not per-sandbox, so it runs only when NO sandboxes remain (or on --all). The agent's own `uninstall`
# terminates the session and strips the ssh-config Include; best-effort, state may be absent.
remove_sync_state() {
    echo "intentic: removing desktop-sync state…"
    if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
        sync_user="sudo -u $SUDO_USER -H"
        sync_home="$(eval echo "~$SUDO_USER")"
    else
        sync_user=""
        sync_home="$HOME"
    fi
    if [ -x "$sync_home/.intentic/sync/bin/intentic-sync" ]; then
        # shellcheck disable=SC2086 -- $sync_user word-splits into `sudo -u <user> -H` on purpose (empty when not under sudo)
        $sync_user "$sync_home/.intentic/sync/bin/intentic-sync" uninstall >/dev/null 2>&1 || true
    fi
    # shellcheck disable=SC2086 -- see above
    $sync_user rm -rf "$sync_home/.intentic/sync" "$sync_home/.local/bin/intentic-sync" 2>/dev/null || true
}

# The shared dev agent-auth volume (connect.sh's INTENTIC_AGENT_AUTH_VOLUME): the AI-provider OAuth stores for
# ALL dev sandboxes on this machine. It survives cleanup on purpose and is removed only on explicit --agent-auth
# or an interactive yes — NEVER implied by -y, which callers rely on to keep their AI logins across resets (so
# this cannot use confirm(), whose FORCE path auto-answers yes).
AUTH_VOLUME="${INTENTIC_AGENT_AUTH_VOLUME:-intentic-dev-agent-auth}"

remove_agent_auth() {
    echo "intentic: removing shared dev agent-auth volume '$AUTH_VOLUME' (AI logins)…"
    docker volume rm "$AUTH_VOLUME" >/dev/null 2>&1 \
        || echo "intentic: could not remove '$AUTH_VOLUME' — still referenced by a container." >&2
}

maybe_remove_agent_auth() {
    case "$AUTH_VOLUME" in /*) return 0 ;; esac # an absolute host path (connect.sh option) — no docker volume to remove
    docker volume inspect "$AUTH_VOLUME" >/dev/null 2>&1 || return 0
    if [ "$AUTH" = 1 ]; then
        remove_agent_auth
        return 0
    fi
    if [ "$FORCE" = 1 ] || ! have_tty; then
        echo "intentic: kept shared dev agent-auth volume '$AUTH_VOLUME' (AI logins) — pass --agent-auth to remove."
        return 0
    fi
    ask "Also remove the shared dev agent-auth volume '$AUTH_VOLUME'? Logs AI accounts out of ALL dev sandboxes. [y/N] " || return 0
    case "$REPLY" in [Yy]*) remove_agent_auth ;; esac
}

# ── args ──────────────────────────────────────────────────────────────────────────────────────────────────────
FORCE=0
ALL=0
AUTH=0
SLUGS=""
while [ $# -gt 0 ]; do
    case "$1" in
        -a | --all) ALL=1 ;;
        -y | --yes | --force) FORCE=1 ;;
        --agent-auth) AUTH=1 ;;
        -h | --help) usage; exit 0 ;;
        --) shift; break ;;
        -*) echo "error: unknown flag '$1'." >&2; usage >&2; exit 2 ;;
        *) SLUGS="$SLUGS $1" ;;
    esac
    shift
done
for a in "$@"; do SLUGS="$SLUGS $a"; done  # positionals after --

# ── resolve which slugs to remove ─────────────────────────────────────────────────────────────────────────────
if [ "$ALL" = 1 ]; then
    all="$(list_sandboxes)"
    [ -n "$all" ] || { echo "intentic: no sandboxes found on this machine."; maybe_remove_agent_auth; exit 0; }
    echo "intentic: about to PERMANENTLY DELETE ALL sandboxes on this machine and their data (/work + /history):"
    for s in $all; do echo "    $s"; done
    echo "This cannot be undone."
    confirm "Remove all of them?" || { echo "intentic: cancelled — nothing removed."; exit 0; }
    remove_all
    remove_sync_state
    maybe_remove_agent_auth
    echo "intentic: all sandboxes removed. Re-run connect to start fresh."
    exit 0
fi

if [ -z "$SLUGS" ]; then
    # No slug given and not --all: pick interactively, or (no tty) list and stop without touching anything.
    slugs="$(list_sandboxes)"
    [ -n "$slugs" ] || { echo "intentic: no sandboxes found on this machine."; maybe_remove_agent_auth; exit 0; }

    echo "intentic: sandboxes on this machine:"
    i=0
    for s in $slugs; do
        i=$((i + 1))
        st="$(docker inspect -f '{{.State.Status}}' "intentic-sandbox-$s" 2>/dev/null || echo '?')"
        printf '  %d) %-9s %s\n' "$i" "$st" "$s"
    done

    if ! have_tty; then
        echo "intentic: no terminal for interactive selection — nothing removed." >&2
        echo "Re-run with a SLUG, or --all to remove every sandbox (add -y to skip prompts)." >&2
        exit 1
    fi

    ask 'Select sandbox(es) to remove — numbers (e.g. "1 3"), "a" = all, "q" = cancel: ' \
        || { echo "intentic: cancelled — nothing removed."; exit 0; }
    case "$REPLY" in
        "" | q | Q) echo "intentic: cancelled — nothing removed."; exit 0 ;;
        a | A) SLUGS="$slugs" ;;
        *)
            for tok in $REPLY; do
                case "$tok" in
                    '' | *[!0-9]*) echo "intentic: ignoring invalid selection '$tok'." >&2; continue ;;
                esac
                if [ "$tok" -lt 1 ] || [ "$tok" -gt "$i" ]; then
                    echo "intentic: ignoring out-of-range selection '$tok'." >&2
                    continue
                fi
                # shellcheck disable=SC2086 -- $slugs is a whitespace-separated slug list (slugs never contain spaces)
                SLUGS="$SLUGS $(nth "$tok" $slugs)"
            done
            ;;
    esac
fi

# Normalize and bail if the selection was empty/all-invalid.
# shellcheck disable=SC2086 -- re-split the accumulated slug list
set -- $SLUGS
[ $# -gt 0 ] || { echo "intentic: nothing selected — nothing removed."; exit 0; }

echo "intentic: about to PERMANENTLY DELETE these sandbox(es) and their data (/work + /history):"
for s in "$@"; do echo "    $s"; done
echo "This cannot be undone."
confirm "Proceed?" || { echo "intentic: cancelled — nothing removed."; exit 0; }

for s in "$@"; do
    remove_slug "$s"
done

# Desktop sync and the agent-auth volume are host-wide, not per-slug (and the volume stays docker-locked while any
# sandbox container references it): tear them down only once every sandbox is gone.
if [ -n "$(list_sandboxes)" ]; then
    if [ "$AUTH" = 1 ]; then
        echo "intentic: kept shared dev agent-auth volume '$AUTH_VOLUME' — other sandboxes still reference it." >&2
    fi
else
    remove_sync_state
    maybe_remove_agent_auth
fi

echo "intentic: done. Remaining sandboxes: $(list_sandboxes | tr '\n' ' ' | sed 's/ *$//' || true)"
