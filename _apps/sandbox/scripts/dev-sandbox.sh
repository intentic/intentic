#!/bin/sh
# intentic dev-sandbox recreate — swap the running sandbox container over to a freshly built
# `intentic-sandbox:dev` image, WITHOUT re-running connect.sh's tunnel/auth wizard. Called by the
# watch loop (the sibling dev-sandbox.mjs) after each `pnpm build:sandbox`, but also usable by hand.
#
# This is the recreate half of _apps/site/public/scripts/rebuild.sh with the overlay hashing/verification stripped out:
# the dev image is local and trusted, so there is no owner-approval step. It targets the SAME
# container/network/volumes connect.sh created and replays the running container's env, so the
# already-established Cloudflare tunnel + Google auth keep working across the swap (the tunnel sidecar
# keeps running and reconnects to the network alias).
#
# NOTE: the env allowlist below must stay in lockstep with connect.sh's `docker run -e` list and
# rebuild.sh's replay list — the three are delivered standalone (connect.sh/rebuild.sh via curl|sh),
# so they can't source a shared helper; they share the PATTERN, not a file.
set -eu

TAG="intentic-sandbox:dev"
ORIGIN_HOST="intentic-sandbox-workspace"

if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is required — run this on the machine that runs the sandbox." >&2
    exit 1
fi

# The dev image must exist (the watcher builds it before calling us; a manual run needs it prebuilt).
if ! docker image inspect "$TAG" >/dev/null 2>&1; then
    echo "error: image ${TAG} not found — run 'pnpm build:sandbox' first." >&2
    exit 1
fi

# Auto-detect the single running sandbox container. connect.sh names it intentic-sandbox-<slug> and the
# tunnel sidecar intentic-sandbox-tunnel-<slug>; exclude the latter. Require exactly one so we never
# recreate the wrong sandbox when several are up.
matches="$(docker ps --filter 'name=^intentic-sandbox-' --format '{{.Names}}' | grep -v -- '-tunnel-' || true)"
count="$(printf '%s\n' "$matches" | grep -c . || true)"
if [ "$count" -eq 0 ]; then
    echo "error: no running sandbox container found — run 'SANDBOX_IMAGE=${TAG} bash _apps/site/public/scripts/connect.sh' first." >&2
    exit 1
fi
if [ "$count" -gt 1 ]; then
    echo "error: more than one running sandbox container — refusing to guess which to recreate:" >&2
    printf '  %s\n' $matches >&2
    exit 1
fi
CONTAINER="$matches"

# Per-sandbox names, derived from the container name exactly like connect.sh/rebuild.sh derive them
# from the slug, so we hit the same volumes + network.
SLUG="${CONTAINER#intentic-sandbox-}"
WORKSPACE_VOLUME="intentic-workspace-${SLUG}"
HISTORY_VOLUME="intentic-history-${SLUG}"
DOCKER_VOLUME="intentic-docker-${SLUG}"
NETWORK="intentic-workspace-${SLUG}"

# Replay the running container's env as argv (never word-split — HOST_SSH_KEY is a multi-line key),
# allowlisted to exactly the vars connect.sh sets (SANDBOX_IMAGE is forced to the dev tag below, so it
# is intentionally NOT replayed). Empty values are dropped, not replayed: an empty secret var would
# shadow the value the user later writes to the workspace .env.
set --
for var in WORKSPACE_ROOT HISTORY_ROOT AGENT_AUTH_DIR SANDBOX_HOST SANDBOX_PORT SANDBOX_NAME PREVIEW_PORT \
    GOOGLE_CLIENT_ID CONNECT_TOKEN OWNER_EMAIL WEB_ORIGIN SANDBOX_PUBLIC_URL PLATFORM_URL CLOUDFLARE_API_TOKEN \
    HOST_SSH_KEY SELF_HOST_USER SYNC_PAIR_TOKEN SELF_HOST_ADDRESS SELF_HOST_VIA; do
    if value="$(docker exec "$CONTAINER" printenv "$var" 2>/dev/null)" && [ -n "$value" ]; then
        set -- "$@" -e "${var}=${value}"
    fi
done

# AGENT_AUTH_DIR is a mount+env pair (connect.sh's INTENTIC_AGENT_AUTH_VOLUME): replaying the env
# without its /agent-auth mount would point the daemon at an empty container-local dir.
auth_src="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/agent-auth"}}{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
[ -n "$auth_src" ] && set -- "$@" -v "${auth_src}:/agent-auth"

# The composed overlay on /work: the source of both the container's privileges AND its extra tooling. No hash
# check anywhere below — the dev recreate has no owner-approval step (the whole point of this script), and it's
# the developer's own machine.
overlay="$(docker exec "$CONTAINER" cat /work/.intentic/environment.approved.Dockerfile 2>/dev/null || true)"

# Replay allowlisted "# intentic:runtime" directives (rebuild.sh's list), so dev sandboxes with the docker/vpn
# capability keep their privileges across a swap.
if [ -n "$overlay" ]; then
    while IFS= read -r line; do
        case "$line" in
            "# intentic:runtime "*)
                for tok in ${line#"# intentic:runtime "}; do
                    case "$tok" in
                        --device=/dev/net/tun | --cap-add=NET_ADMIN | --privileged) set -- "$@" "$tok" ;;
                        *) echo "warning: skipping unsupported runtime directive '$tok' in the overlay." >&2 ;;
                    esac
                done
                ;;
        esac
    done <<EOF
$overlay
EOF
fi

# BUILD the overlay on top of the dev image when it installs anything, and run THAT.
#
# Without this the dev loop and the rebuild loop were mutually exclusive, which is a trap rather than an
# inconvenience: this script gave you a fresh daemon with none of the overlay's packages (a vpn capability's
# openconnect/strongSwan never got installed, so the feature read as "needs a rebuild" forever), while
# rebuild.sh gave you the packages by building FROM the published :stable — throwing the freshly-built daemon
# away and replacing it with the last release. Neither container could both run new code and have the tooling
# that code drives.
#
# The FROM is rewritten to the dev tag, and SANDBOX_BASE_IMAGE tells the daemon to keep composing against it —
# so the recompose on boot reproduces this exact file, its hash matches the stamp below, and the Environment
# card stays quiet instead of demanding a rebuild that would undo the swap.
RUN_IMAGE="$TAG"
if [ -n "$overlay" ] && printf '%s\n' "$overlay" | grep -qE '^\s*(RUN|ENV)\s'; then
    dev_overlay="$(mktemp)"
    trap 'rm -f "$dev_overlay"' EXIT
    printf '%s\n' "$overlay" | sed -E "1,/^[[:space:]]*FROM[[:space:]]/ s|^[[:space:]]*FROM[[:space:]].*|FROM ${TAG}|" >"$dev_overlay"
    ENV_HASH="$({ sha256sum "$dev_overlay" 2>/dev/null || shasum -a 256 "$dev_overlay"; } | cut -c1-64)"
    RUN_IMAGE="intentic-sandbox-dev-env-${SLUG}:$(printf '%s' "$ENV_HASH" | cut -c1-12)"
    echo "intentic: building ${RUN_IMAGE} — the overlay's tooling on top of ${TAG}…"
    if ! docker build -t "$RUN_IMAGE" - <"$dev_overlay"; then
        echo "error: building the dev overlay failed — the sandbox is untouched." >&2
        exit 1
    fi
    set -- "$@" -e SANDBOX_ENVIRONMENT_HASH="$ENV_HASH"
fi
# Always named, even with no overlay: it is what stops a later recompose from flipping the base to :stable.
set -- "$@" -e SANDBOX_BASE_IMAGE="$TAG"

# Bind the compiled JS from the working tree over the copies baked into the image, so a later daemon edit needs
# only `tsgo` + `docker restart` (dev-reload.sh, seconds) instead of a full image rebuild (minutes). Skipped
# silently when node isn't on PATH or nothing is compiled yet — the container then runs the baked copies, which
# is exactly the old behaviour. See dev-mounts.mjs for what is mounted and why node_modules never is.
if command -v node >/dev/null 2>&1; then
    mount_count=0
    while IFS= read -r mount; do
        [ -n "$mount" ] || continue
        set -- "$@" -v "$mount"
        mount_count=$((mount_count + 1))
    done <<EOF
$(node "$(dirname "$0")/dev-mounts.mjs" 2>/dev/null || true)
EOF
    [ "$mount_count" -gt 0 ] && echo "intentic: mounting ${mount_count} compiled tree(s) from the working tree — daemon edits reload with dev-reload.sh."
fi

echo "intentic: recreating ${CONTAINER} from ${RUN_IMAGE}…"
docker rm -f "$CONTAINER" >/dev/null
# Same shape as connect.sh's run: unprivileged unless the overlay's directives grant privileges, per-sandbox
# network + the stable tunnel-origin alias, the persistent /work + /history + /var/lib/docker volumes, bounded
# json-file logs.
# SYS_ADMIN matches connect.sh/rebuild.sh/update.sh: it is what lets the daemon give each isolated agent turn
# its own mount namespace (agents/isolation.ts). This script was the LAST creation path to gain it — being the
# dogfood rebuild, that meant two "recreate the sandbox to restore full isolation" rebuilds in a row recreated
# it through the one door still missing the flag. If another `docker run` for the sandbox container is ever
# added anywhere, it needs this flag too.
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
    -e SANDBOX_IMAGE="$RUN_IMAGE" \
    "$RUN_IMAGE" >/dev/null; then
    echo "error: starting the recreated sandbox failed." >&2
    exit 1
fi

# Gate on the daemon's own /health before declaring success — a container that starts but crash-loops
# would otherwise look "done" to the watcher.
echo "intentic: waiting for the sandbox daemon to come up…"
tries=0
until docker exec "$CONTAINER" curl -sf http://localhost:8787/health >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 15 ]; then
        docker logs --tail 50 "$CONTAINER" >&2 || true
        echo "error: the recreated sandbox did not become healthy within 30s (logs above)." >&2
        exit 1
    fi
    sleep 2
done

echo "intentic: sandbox is live on ${RUN_IMAGE} — docker logs -f ${CONTAINER}"
