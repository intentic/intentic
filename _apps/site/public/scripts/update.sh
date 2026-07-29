#!/bin/sh
# intentic update — pull the latest sandbox image (:stable) and recreate THIS machine's sandbox container from
# it, preserving /work + /history. The sandbox holds no HOST Docker socket (its own engine is nested), so —
# like rebuild.sh — the update runs HERE, on the machine that runs the container. The platform's Sandbox card hands you this one-liner when a
# newer release is available.
#
# No hash and no connect token: the base image is trusted by its :stable tag, and every env var is replayed
# from the running container. If an owner-approved overlay is present it is rebuilt (--pull) FROM the fresh
# base, so the extended environment (packages, toolchains, SDKs) carries onto the new image.
#
# Usage (the platform's Sandbox card hands you the exact command):
#   curl -fsSL https://intentic.dev/update | sh -s -- <SLUG>
#
# POSIX sh (piped into `sh`, like connect.sh / rebuild.sh).
set -eu

SLUG="${1:?usage: update.sh <slug>}"
# The moving release tag by default; SANDBOX_IMAGE overrides it for dev, exactly like connect.sh.
IMAGE="${SANDBOX_IMAGE:-registry.gitlab.com/radarsu/intentic/sandbox:stable}"

# Per-sandbox names, derived exactly like connect.sh/rebuild.sh so this targets the same container/volumes/network.
CONTAINER="intentic-sandbox-${SLUG}"
WORKSPACE_VOLUME="intentic-workspace-${SLUG}"
HISTORY_VOLUME="intentic-history-${SLUG}"
DOCKER_VOLUME="intentic-docker-${SLUG}"
NETWORK="intentic-workspace-${SLUG}"
ORIGIN_HOST="intentic-sandbox-workspace"
APPROVED_FILE="/work/.intentic/environment.approved.Dockerfile"

# Every update leaves a log on this machine (pull/build output, the replaced container's tail, launch failures);
# the rm below destroys the old container's `docker logs`, so its tail is captured here first. Newest 10 kept.
LOG_DIR="${INTENTIC_LOG_DIR:-$HOME/.intentic/logs}"
mkdir -p "$LOG_DIR"
ls -1t "$LOG_DIR"/update-*.log 2>/dev/null | tail -n +10 | xargs rm -f 2>/dev/null || true
LOG="$LOG_DIR/update-$(date +%Y%m%d-%H%M%S).log"

if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is required — run this on the machine that runs the sandbox." >&2
    exit 1
fi
if [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" != "true" ]; then
    echo "error: sandbox container ${CONTAINER} is not running on this machine — start it (or re-run connect) first." >&2
    exit 1
fi

# Pull a published image, mirroring connect.sh: the sandbox image is PUBLIC, so no login is needed, but a
# stale/expired `docker login registry.gitlab.com` (Docker Desktop's credential store) makes docker present that
# token and the registry reject the pull. On failure, clear that login and retry anonymously.
pull_image() {
    if docker pull "$1"; then
        return 0
    fi
    if docker image inspect "$1" >/dev/null 2>&1; then
        echo "intentic: pull failed but the image exists locally — using the local copy." >&2
        return 0
    fi
    echo "intentic: pull failed — clearing a stale registry.gitlab.com login and retrying anonymously…" >&2
    docker logout registry.gitlab.com >/dev/null 2>&1 || true
    docker pull "$1"
}

# Pull the latest base up front — a moved :stable tag is exactly what makes an update available, and `docker
# run` reuses a cached tag without re-pulling. Capture the image id before/after so a no-op pull (already on the
# newest :stable, or an unreachable registry falling back to the local copy) is reported honestly instead of
# silently recreating the SAME image and claiming success.
echo "intentic: pulling ${IMAGE}…"
echo "== docker pull ${IMAGE} ==" >>"$LOG"
before_id="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
pull_image "$IMAGE" 2>&1 | tee -a "$LOG" || true
after_id="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)"

# Nothing newer arrived: the running sandbox is already this image, so recreating it would be pointless downtime.
# The version banner is driven by the release feed, which can lead the :stable image by the publish window.
if [ -n "$before_id" ] && [ "$before_id" = "$after_id" ]; then
    echo "intentic: no newer sandbox image is available yet — your sandbox is already on the latest :stable it can pull."
    echo "          If the app still shows an update, the new release's image may still be publishing — try again in a few minutes."
    exit 0
fi

# Default: recreate straight from the fresh base. If an owner-approved overlay exists, rebuild it (--pull) FROM
# the fresh base instead, so the extended environment carries onto the new image. The overlay lives on the
# workspace volume; copy it out once and build that same copy.
TARGET_IMAGE="$IMAGE"
ENV_HASH=""
# The upstream image the container ends up extending — passed through as SANDBOX_BASE_IMAGE so the daemon keeps
# composing against the same base instead of falling back to the release tag and re-prompting a rebuild.
BASE_IMAGE="$IMAGE"
overlay="$(mktemp)"
trap 'rm -f "$overlay"' EXIT
if docker cp "${CONTAINER}:${APPROVED_FILE}" "$overlay" >/dev/null 2>&1 && [ -s "$overlay" ]; then
    # Belt-and-braces (the daemon enforced it at approval), matching rebuild.sh: the overlay may extend any
    # OFFICIAL sandbox image, or the exact base this container was already created from (SANDBOX_BASE_IMAGE,
    # set at `docker run` by whichever runner made it — not a value the agent can write). The --pull build then
    # re-fetches that base.
    BASE_IMAGE="$(awk 'NF && $1 !~ /^#/ { if ($1 == "FROM") print $2; exit }' "$overlay")"
    CURRENT_BASE="$(docker exec "$CONTAINER" printenv SANDBOX_BASE_IMAGE 2>/dev/null || true)"
    if [ -z "$BASE_IMAGE" ]; then
        echo "error: the approved overlay has no FROM instruction." >&2
        exit 1
    fi
    case "$BASE_IMAGE" in
        registry.gitlab.com/radarsu/intentic/sandbox:?*) ;;
        *)
            if [ -z "$CURRENT_BASE" ] || [ "$BASE_IMAGE" != "$CURRENT_BASE" ]; then
                echo "error: the approved overlay must start with FROM registry.gitlab.com/radarsu/intentic/sandbox:<tag>" >&2
                echo "       (or FROM this sandbox's own base, ${CURRENT_BASE:-<none>}); found ${BASE_IMAGE}." >&2
                exit 1
            fi
            ;;
    esac
    # The full hash pins SANDBOX_ENVIRONMENT_HASH (so the daemon reports the overlay as Applied); the first 12
    # chars tag the built image — identical derivation to rebuild.sh.
    ENV_HASH="$({ sha256sum "$overlay" 2>/dev/null || shasum -a 256 "$overlay"; } | cut -c1-64)"
    TARGET_IMAGE="intentic-sandbox-env-${SLUG}:$(printf '%s' "$ENV_HASH" | cut -c1-12)"
    echo "intentic: rebuilding your environment overlay on the new base…"
    echo "== docker build --pull ${TARGET_IMAGE} ==" >>"$LOG"
    docker build --pull -t "$TARGET_IMAGE" - <"$overlay" 2>&1 | tee -a "$LOG" || true
fi

# Guard BEFORE touching the container: if the target image isn't present (pull failed and no local copy, or the
# overlay build failed), leave the running sandbox untouched — a pipeline's exit status is tee's, so pull/build
# failures don't trip `set -e`; this inspect is the real check.
if ! docker image inspect "$TARGET_IMAGE" >/dev/null 2>&1; then
    echo "error: ${TARGET_IMAGE} is not available locally (pull or overlay build failed) — the sandbox is untouched. Log: ${LOG}" >&2
    exit 1
fi

# Replay the running container's env as argv (never word-split — HOST_SSH_KEY is a multi-line key), allowlisted
# to exactly the vars connect.sh sets. SANDBOX_IMAGE is overridden with TARGET_IMAGE in the run below.
set --
for var in WORKSPACE_ROOT HISTORY_ROOT SANDBOX_HOST SANDBOX_PORT SANDBOX_NAME PREVIEW_PORT \
    GOOGLE_CLIENT_ID CONNECT_TOKEN OWNER_EMAIL WEB_ORIGIN SANDBOX_PUBLIC_URL PLATFORM_URL CLOUDFLARE_API_TOKEN \
    HOST_SSH_KEY SELF_HOST_USER SYNC_PAIR_TOKEN SELF_HOST_ADDRESS SELF_HOST_VIA; do
    # Empty values are dropped, not replayed (lockstep with connect.sh): an empty secret var would shadow the
    # value the user writes to the workspace .env.
    if value="$(docker exec "$CONTAINER" printenv "$var" 2>/dev/null)" && [ -n "$value" ]; then
        set -- "$@" -e "${var}=${value}"
    fi
done
# An overlay build pins its content hash so the daemon reports Applied (not Pending) against the new image.
if [ -n "$ENV_HASH" ]; then
    set -- "$@" -e "SANDBOX_ENVIRONMENT_HASH=${ENV_HASH}"
fi

# Container privileges come ONLY from "# intentic:runtime" directives in the approved overlay — same hard
# allowlist as rebuild.sh (a plain base update has none, and runs unprivileged): the vpn's tun + NET_ADMIN,
# the docker capability's --privileged.
if [ -s "$overlay" ]; then
    while IFS= read -r line; do
        case "$line" in
            "# intentic:runtime "*)
                for tok in ${line#"# intentic:runtime "}; do
                    case "$tok" in
                        --device=/dev/net/tun | --cap-add=NET_ADMIN | --privileged) set -- "$@" "$tok" ;;
                        *)
                            echo "error: unsupported runtime directive '$tok' in the approved overlay." >&2
                            exit 1
                            ;;
                    esac
                done
                ;;
        esac
    done <"$overlay"
fi

echo "intentic: recreating the sandbox from ${TARGET_IMAGE}…"
# Keep the old container's log tail before the rm destroys it (the only record of a pre-update problem).
echo "== previous container logs (${CONTAINER}) ==" >>"$LOG"
docker logs --tail 5000 "$CONTAINER" >>"$LOG" 2>&1 || true
docker rm -f "$CONTAINER" >/dev/null
# Same shape as connect.sh's run: unprivileged unless the overlay's directives grant privileges, the
# per-sandbox network + stable tunnel-origin alias, the persistent /work + /history + /var/lib/docker volumes,
# bounded json-file logs. The tunnel sidecar keeps running and reconnects to the alias.
echo "== docker run ${TARGET_IMAGE} ==" >>"$LOG"
# SYS_ADMIN is what lets the daemon give each isolated agent turn its own mount namespace, with that
# conversation's worktree standing in for the workspace root (the sandbox app's agents/isolation.ts). Without
# it the daemon still runs every turn — it just cannot make the guarantee, and an agent's absolute workspace
# paths reach the shared checkout again. The capability is scoped to THIS container's own mounts; it is not host access, and
# the docker socket is still never mounted. Kept in lockstep with the platform provider's own run
# (_libs/providers/src/host/workspace.ts), which is a SEPARATE path to the same container: it had this flag
# while these scripts did not, so a sandbox created or rebuilt the ordinary way silently lost the isolation.
if ! docker run -d --init --restart unless-stopped --name "$CONTAINER" \
    --network "$NETWORK" \
    --network-alias "$ORIGIN_HOST" \
    --add-host host.docker.internal:host-gateway \
    --log-opt max-size=10m --log-opt max-file=3 \
    --cap-add=SYS_ADMIN \
    -v "${WORKSPACE_VOLUME}:/work" \
    -v "${HISTORY_VOLUME}:/history" \
    -v "${DOCKER_VOLUME}:/var/lib/docker" \
    "$@" \
    -e SANDBOX_IMAGE="$TARGET_IMAGE" \
    -e SANDBOX_BASE_IMAGE="$BASE_IMAGE" \
    "$TARGET_IMAGE" >/dev/null 2>>"$LOG"; then
    tail -n 5 "$LOG" >&2
    echo "error: starting the updated sandbox failed. The previous container's logs and this error are saved to ${LOG}." >&2
    echo "       Re-run your connect one-liner to restore the sandbox." >&2
    exit 1
fi

# A container that starts but crash-loops would otherwise look "done" — gate on the daemon's own /health.
echo "intentic: waiting for the sandbox daemon to come up…"
tries=0
until docker exec "$CONTAINER" curl -sf http://localhost:8787/health >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 15 ]; then
        echo "== updated container logs (${CONTAINER}) ==" >>"$LOG"
        docker logs --tail 500 "$CONTAINER" >>"$LOG" 2>&1 || true
        echo "error: the updated sandbox did not become healthy within 30s — its logs are saved to ${LOG}." >&2
        echo "       Re-run your connect one-liner to restore the sandbox." >&2
        exit 1
    fi
    sleep 2
done

echo "intentic: sandbox updated — the Sandbox card will show the new version once it reconnects."
echo "Logs: docker logs -f ${CONTAINER} (update log: ${LOG})"
