#!/bin/sh
# intentic rebuild — rebuild THIS machine's sandbox from its owner-approved overlay Dockerfile and recreate
# the container from the result, extending the agent's environment (system packages, toolchains, SDKs).
#
# How: the agent proposes .intentic/environment.Dockerfile inside the sandbox; the owner approves it in the
# browser (the daemon copies it to .intentic/environment.approved.Dockerfile) and the platform's Environment
# card hands them this one-liner. The sandbox holds no HOST Docker socket (its own engine is nested — it
# cannot recreate its own container), so the rebuild runs HERE: read the approved
# overlay off the workspace volume, verify it against the hash pinned in the pasted command, build, and
# recreate the container with the same env/volumes/network as connect.sh (the /work volume persists).
#
# The SHA256 argument is the trust anchor: the overlay lives on the workspace volume the agent can write, so
# this script builds ONLY content that still hashes to what the owner reviewed in the browser.
#
# Usage (the platform's Environment card hands you the exact command):
#   curl -fsSL https://intentic.dev/rebuild | sh -s -- <SLUG> <SHA256>
#
# POSIX sh (piped into `sh`, like connect.sh).
set -eu

SLUG="${1:?usage: rebuild.sh <slug> <sha256-of-approved-overlay>}"
WANT_HASH="${2:?usage: rebuild.sh <slug> <sha256-of-approved-overlay>}"

# Per-sandbox names, derived exactly like connect.sh so this script targets the same container/volumes/network.
CONTAINER="intentic-sandbox-${SLUG}"
WORKSPACE_VOLUME="intentic-workspace-${SLUG}"
HISTORY_VOLUME="intentic-history-${SLUG}"
DOCKER_VOLUME="intentic-docker-${SLUG}"
NETWORK="intentic-workspace-${SLUG}"
ORIGIN_HOST="intentic-sandbox-workspace"
APPROVED_FILE="/work/.intentic/environment.approved.Dockerfile"

# Every rebuild leaves a log on this machine (build output, the replaced container's tail, launch failures) —
# without it a failed capability rebuild is only ever seen on this terminal, and the old container's logs are
# destroyed by the rm below. Kept to the newest 10 rebuilds; same dir the intentic CLI logs its runs to.
LOG_DIR="${INTENTIC_LOG_DIR:-$HOME/.intentic/logs}"
mkdir -p "$LOG_DIR"
ls -1t "$LOG_DIR"/rebuild-*.log 2>/dev/null | tail -n +10 | xargs rm -f 2>/dev/null || true
LOG="$LOG_DIR/rebuild-$(date +%Y%m%d-%H%M%S).log"

if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is required — run this on the machine that runs the sandbox." >&2
    exit 1
fi
if [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" != "true" ]; then
    echo "error: sandbox container ${CONTAINER} is not running on this machine — start it (or re-run connect) first." >&2
    exit 1
fi

# Copy the approved overlay out ONCE and hash/build that same copy — a byte-exact read (command substitution
# would strip trailing newlines and change the hash), and no window for the file to change between the hash
# check and the build.
overlay="$(mktemp)"
trap 'rm -f "$overlay"' EXIT
if ! docker cp "${CONTAINER}:${APPROVED_FILE}" "$overlay" >/dev/null 2>&1; then
    echo "error: no approved overlay found in the sandbox — approve the proposal on the Environment card first." >&2
    exit 1
fi

have_hash="$({ sha256sum "$overlay" 2>/dev/null || shasum -a 256 "$overlay"; } | cut -c1-64)"
if [ "$have_hash" != "$WANT_HASH" ]; then
    echo "error: the approved overlay changed since it was reviewed (expected ${WANT_HASH}, found ${have_hash})." >&2
    echo "       Re-review and re-approve it on the Environment card, then run the fresh command it shows." >&2
    exit 1
fi
# The upstream image this overlay extends, and the belt-and-braces check on it (the daemon already enforced
# this at approval). Two bases are legal: any OFFICIAL sandbox image, or the exact base this container was
# already created from — SANDBOX_BASE_IMAGE, set at `docker run` by whichever runner made it, so it is not a
# value the agent can write. The second case is what lets a locally-built image (intentic-sandbox:dev) be
# rebuilt onto itself; without it, rebuilding a dev sandbox silently replaced its daemon with the last release.
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

# Build BEFORE touching the container, so a failed build leaves the sandbox running untouched. Stdin build:
# the overlay is FROM + RUN/ENV only, so there is no build context to send. The tee keeps the full build
# output in $LOG; success is checked via image inspect because a pipeline's exit status is tee's (POSIX sh,
# no pipefail).
TAG="intentic-sandbox-env-${SLUG}:$(printf '%s' "$WANT_HASH" | cut -c1-12)"
echo "intentic: building ${TAG} from the approved overlay…"
echo "== docker build ${TAG} ==" >>"$LOG"
docker build -t "$TAG" - <"$overlay" 2>&1 | tee -a "$LOG" || true
if ! docker image inspect "$TAG" >/dev/null 2>&1; then
    echo "error: building the approved overlay failed — the sandbox is untouched. Full build log: ${LOG}" >&2
    exit 1
fi

# Replay the running container's env as argv (never word-split — HOST_SSH_KEY is a multi-line key), allowlisted
# to exactly the vars connect.sh sets (keep this list in lockstep with connect.sh's docker run) so an overlay's
# own ENV (e.g. PATH) isn't clobbered by image-baked values. SANDBOX_IMAGE is overridden with the new tag below.
set --
for var in AGENT_AUTH_DIR SANDBOX_NAME PREVIEW_PORT \
    GOOGLE_CLIENT_ID CONNECT_TOKEN OWNER_EMAIL WEB_ORIGIN SANDBOX_PUBLIC_URL PLATFORM_URL CLOUDFLARE_API_TOKEN \
    HOST_SSH_KEY SELF_HOST_USER SYNC_PAIR_TOKEN SELF_HOST_ADDRESS SELF_HOST_VIA; do
    # Empty values are dropped, not replayed (lockstep with connect.sh): an empty secret var would shadow the
    # value the user writes to the workspace .env — rebuilding also heals a container that carried one.
    if value="$(docker exec "$CONTAINER" printenv "$var" 2>/dev/null)" && [ -n "$value" ]; then
        set -- "$@" -e "${var}=${value}"
    fi
done

# AGENT_AUTH_DIR is a mount+env pair (connect.sh's INTENTIC_AGENT_AUTH_VOLUME): replaying the env without its
# /agent-auth mount would point the daemon at an empty container-local dir, stranding the shared credentials.
auth_src="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/agent-auth"}}{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
[ -n "$auth_src" ] && set -- "$@" -v "${auth_src}:/agent-auth"

# Container privileges come ONLY from "# intentic:runtime" directive lines in the hash-verified overlay —
# emitted by capability fragments (the vpn's WireGuard needs tun + NET_ADMIN; the docker capability's nested
# engine needs --privileged) — allowlisted hard so an overlay can't smuggle arbitrary docker flags. The base
# run below is unprivileged: this replay is the one path to a privileged sandbox, and it only ever executes
# content the owner reviewed (the hash check above). The hosted workspace provider keeps its own matching
# allowlist.
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

echo "intentic: recreating the sandbox from ${TAG}…"
# The rm destroys the old container's `docker logs` — keep its tail in $LOG first (the only record of why a
# pre-rebuild sandbox was misbehaving).
echo "== previous container logs (${CONTAINER}) ==" >>"$LOG"
docker logs --tail 5000 "$CONTAINER" >>"$LOG" 2>&1 || true
docker rm -f "$CONTAINER" >/dev/null
# Same shape as connect.sh's run: unprivileged unless the overlay's directives grant privileges, per-sandbox
# network + the stable tunnel-origin alias, the persistent /work + /history + /var/lib/docker volumes, bounded
# json-file logs. The tunnel sidecar keeps running and reconnects to the alias.
echo "== docker run ${TAG} ==" >>"$LOG"
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
    -e SANDBOX_IMAGE="$TAG" \
    -e SANDBOX_BASE_IMAGE="$BASE_IMAGE" \
    -e SANDBOX_ENVIRONMENT_HASH="$WANT_HASH" \
    "$TAG" >/dev/null 2>>"$LOG"; then
    tail -n 5 "$LOG" >&2
    echo "error: starting the rebuilt sandbox failed (a runtime flag the host rejects, e.g. --privileged or /dev/net/tun?)." >&2
    echo "       The previous container's logs and this error are saved to ${LOG}. Re-run your connect one-liner to restore the stock sandbox." >&2
    exit 1
fi

# A container that starts but crash-loops (an overlay that breaks the daemon) would otherwise time out
# silently in the setup wizard — gate on the daemon's own /health before declaring success.
echo "intentic: waiting for the sandbox daemon to come up…"
tries=0
until docker exec "$CONTAINER" curl -sf http://localhost:8787/health >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 15 ]; then
        echo "== rebuilt container logs (${CONTAINER}) ==" >>"$LOG"
        docker logs --tail 500 "$CONTAINER" >>"$LOG" 2>&1 || true
        echo "error: the rebuilt sandbox did not become healthy within 30s — its logs are saved to ${LOG}." >&2
        echo "       Re-run your connect one-liner to restore the stock sandbox." >&2
        exit 1
    fi
    sleep 2
done

echo "intentic: sandbox rebuilt — the Environment card will show Applied once it reconnects."
echo "Logs: docker logs -f ${CONTAINER} (rebuild log: ${LOG})"
