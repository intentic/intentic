#!/bin/sh
# intentic recreate — swap THIS machine's sandbox container onto a different image, preserving /work,
# /history, the tunnel, and every setting the container carries. One script, three ways in, because the three
# were always one flow with different pre-steps:
#
#   curl -fsSL https://intentic.dev/rebuild | sh -s -- <SLUG> <SHA256>   # rebuild: the owner-approved overlay
#   curl -fsSL https://intentic.dev/update  | sh -s -- <SLUG>            # update: the fresh :stable base
#   sh recreate.sh --dev                                                 # dev: the locally-built dev image
#
# rebuild — the agent proposed .intentic/environment.Dockerfile, the owner approved it in the browser, and the
#   platform's Environment card handed over this one-liner. The SHA256 is the trust anchor: the overlay lives
#   on the workspace volume the agent can write, so only content that still hashes to what the owner reviewed
#   is ever built. update — pulls the moving :stable tag and re-applies the approved overlay (if any) onto it,
#   so the extended environment carries forward. dev — the dogfood loop: the sibling dev-sandbox.sh wrapper
#   builds intentic-sandbox:dev from the checkout and calls this with the overlay re-based onto it.
#
# The sandbox holds no HOST Docker socket (its own engine is nested — it cannot recreate its own container),
# which is why every mode runs HERE, on the machine that runs the container.
#
# HOW THE CONTAINER IS RUN is deliberately not written in this file. The docker-run shape (volumes, network,
# capability posture, env allowlist) is the run contract (@intentic/sandbox-run), and the TARGET IMAGE carries
# the CLI that speaks it: this script dumps the old container's env (NUL-framed — HOST_SSH_KEY is a multi-line
# key) into `intentic sandbox run-command` and executes exactly what the image answers. The contract ships
# with the image, so this script keeps working, unchanged, as the contract evolves — the hand-copied run
# blocks it replaced were three "keep in lockstep" comments and one real drift incident deep.
#
# POSIX sh (piped into `sh`, like connect.sh).
set -eu

REGISTRY_IMAGE="${SANDBOX_IMAGE:-registry.gitlab.com/radarsu/intentic/sandbox:stable}"
APPROVED_FILE="/work/.intentic/environment.approved.Dockerfile"
DEV_TAG="intentic-sandbox:dev"

# Mode by argument shape, so every one-liner the platform ever handed out keeps working: the Environment
# card's rebuild command passes <slug> <sha256>, the Sandbox card's update command passes <slug> alone.
MODE=""
SLUG=""
WANT_HASH=""
case "${1:-}" in
    --dev) MODE="dev" ;;
    "") echo "usage: recreate.sh <slug> [sha256-of-approved-overlay] | recreate.sh --dev" >&2 && exit 1 ;;
    *)
        SLUG="$1"
        if [ -n "${2:-}" ]; then
            MODE="rebuild"
            WANT_HASH="$2"
        else
            MODE="update"
        fi
        ;;
esac

if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is required — run this on the machine that runs the sandbox." >&2
    exit 1
fi

if [ "$MODE" = "dev" ]; then
    # Auto-detect the single running sandbox (exclude the tunnel sidecar); refuse to guess between several.
    matches="$(docker ps --filter 'name=^intentic-sandbox-' --format '{{.Names}}' | grep -v -- '-tunnel-' || true)"
    count="$(printf '%s\n' "$matches" | grep -c . || true)"
    if [ "$count" -ne 1 ]; then
        [ "$count" -eq 0 ] && echo "error: no running sandbox container found — run connect.sh first." >&2
        [ "$count" -gt 1 ] && { echo "error: more than one running sandbox — refusing to guess:" >&2; printf '  %s\n' $matches >&2; }
        exit 1
    fi
    CONTAINER="$matches"
    SLUG="${CONTAINER#intentic-sandbox-}"
else
    CONTAINER="intentic-sandbox-${SLUG}"
fi
if [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" != "true" ]; then
    echo "error: sandbox container ${CONTAINER} is not running on this machine — start it (or re-run connect) first." >&2
    exit 1
fi

# Every recreate leaves a log on this machine (build/pull output, the replaced container's tail, launch
# failures) — the rm below destroys the old container's `docker logs`, so its tail is captured here first.
LOG_DIR="${INTENTIC_LOG_DIR:-$HOME/.intentic/logs}"
mkdir -p "$LOG_DIR"
ls -1t "$LOG_DIR"/recreate-*.log 2>/dev/null | tail -n +10 | xargs rm -f 2>/dev/null || true
LOG="$LOG_DIR/recreate-${MODE}-$(date +%Y%m%d-%H%M%S).log"

# Pull a published image; a stale/expired `docker login registry.gitlab.com` (Docker Desktop's credential
# store) makes docker present that token and the registry reject the PUBLIC pull — clear it and retry.
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

# ——— The mode pre-step: produce TARGET_IMAGE / BASE_IMAGE / ENV_HASH and the overlay file (may be empty). ———
overlay="$(mktemp)"
envdump="$(mktemp)"
run_command="$(mktemp)"
trap 'rm -f "$overlay" "$envdump" "$run_command"' EXIT
ENV_HASH=""

case "$MODE" in
    rebuild)
        # Copy the approved overlay out ONCE and hash/build that same copy — byte-exact (command substitution
        # strips trailing newlines and changes the hash), no window between the check and the build.
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
        ENV_HASH="$WANT_HASH"
        ;;
    update)
        # Pull the latest base up front — a moved :stable tag is exactly what makes an update available, and
        # `docker run` reuses a cached tag without re-pulling. A no-op pull is reported honestly, not
        # recreated into the same image and claimed as success.
        echo "intentic: pulling ${REGISTRY_IMAGE}…"
        echo "== docker pull ${REGISTRY_IMAGE} ==" >>"$LOG"
        before_id="$(docker image inspect --format '{{.Id}}' "$REGISTRY_IMAGE" 2>/dev/null || true)"
        pull_image "$REGISTRY_IMAGE" 2>&1 | tee -a "$LOG" || true
        after_id="$(docker image inspect --format '{{.Id}}' "$REGISTRY_IMAGE" 2>/dev/null || true)"
        if [ -n "$before_id" ] && [ "$before_id" = "$after_id" ]; then
            echo "intentic: no newer sandbox image is available yet — your sandbox is already on the latest :stable it can pull."
            echo "          If the app still shows an update, the new release's image may still be publishing — try again in a few minutes."
            exit 0
        fi
        # Re-apply the approved overlay (if any) FROM the fresh base, so the extended environment carries on.
        docker cp "${CONTAINER}:${APPROVED_FILE}" "$overlay" >/dev/null 2>&1 || : >"$overlay"
        ;;
    dev)
        if ! docker image inspect "$DEV_TAG" >/dev/null 2>&1; then
            echo "error: image ${DEV_TAG} not found — run 'pnpm build:sandbox' first." >&2
            exit 1
        fi
        # The overlay's tooling must ride the dev image too, or the dev loop and the rebuild loop are mutually
        # exclusive: this flow would hand you a fresh daemon missing the vpn/docker capability's packages,
        # while rebuild.sh would hand you the packages on the LAST RELEASE's daemon. The FROM is rewritten to
        # the dev tag; SANDBOX_BASE_IMAGE (below) tells the daemon to keep composing against it.
        docker exec "$CONTAINER" cat "$APPROVED_FILE" >"$overlay" 2>/dev/null || : >"$overlay"
        if [ -s "$overlay" ]; then
            sed -E "1,/^[[:space:]]*FROM[[:space:]]/ s|^[[:space:]]*FROM[[:space:]].*|FROM ${DEV_TAG}|" "$overlay" >"${overlay}.dev"
            mv "${overlay}.dev" "$overlay"
        fi
        ;;
esac

# The base the overlay extends, checked belt-and-braces (the daemon already enforced it at approval): any
# OFFICIAL sandbox image, or the exact base this container was created from (SANDBOX_BASE_IMAGE, set at
# `docker run` by whichever runner made it — not a value the agent can write). The dev mode rewrote FROM to
# its own tag, which IS the current base after the first swap and is pinned as such below either way.
BASE_IMAGE=""
if [ -s "$overlay" ]; then
    BASE_IMAGE="$(awk 'NF && $1 !~ /^#/ { if ($1 == "FROM") print $2; exit }' "$overlay")"
    CURRENT_BASE="$(docker exec "$CONTAINER" printenv SANDBOX_BASE_IMAGE 2>/dev/null || true)"
    if [ -z "$BASE_IMAGE" ]; then
        echo "error: the approved overlay has no FROM instruction." >&2
        exit 1
    fi
    case "$BASE_IMAGE" in
        registry.gitlab.com/radarsu/intentic/sandbox:?* | "$DEV_TAG") ;;
        *)
            if [ -z "$CURRENT_BASE" ] || [ "$BASE_IMAGE" != "$CURRENT_BASE" ]; then
                echo "error: the approved overlay must start with FROM registry.gitlab.com/radarsu/intentic/sandbox:<tag>" >&2
                echo "       (or FROM this sandbox's own base, ${CURRENT_BASE:-<none>}); found ${BASE_IMAGE}." >&2
                exit 1
            fi
            ;;
    esac
fi

# Build the overlay (when there is one) BEFORE touching the container, so a failed build leaves the sandbox
# running untouched. Stdin build — an overlay is FROM + RUN/ENV only, no build context. Success is checked via
# image inspect because a pipeline's exit status is tee's (POSIX sh, no pipefail).
case "$MODE" in
    rebuild)
        TARGET_IMAGE="intentic-sandbox-env-${SLUG}:$(printf '%s' "$ENV_HASH" | cut -c1-12)"
        echo "intentic: building ${TARGET_IMAGE} from the approved overlay…"
        echo "== docker build ${TARGET_IMAGE} ==" >>"$LOG"
        docker build -t "$TARGET_IMAGE" - <"$overlay" 2>&1 | tee -a "$LOG" || true
        ;;
    update)
        TARGET_IMAGE="$REGISTRY_IMAGE"
        BASE_IMAGE="${BASE_IMAGE:-$REGISTRY_IMAGE}"
        if [ -s "$overlay" ]; then
            # The full hash pins SANDBOX_ENVIRONMENT_HASH (so the daemon reports the overlay as Applied); the
            # first 12 chars tag the built image — the same derivation the rebuild mode uses.
            ENV_HASH="$({ sha256sum "$overlay" 2>/dev/null || shasum -a 256 "$overlay"; } | cut -c1-64)"
            TARGET_IMAGE="intentic-sandbox-env-${SLUG}:$(printf '%s' "$ENV_HASH" | cut -c1-12)"
            echo "intentic: rebuilding your environment overlay on the new base…"
            echo "== docker build --pull ${TARGET_IMAGE} ==" >>"$LOG"
            docker build --pull -t "$TARGET_IMAGE" - <"$overlay" 2>&1 | tee -a "$LOG" || true
        fi
        ;;
    dev)
        TARGET_IMAGE="$DEV_TAG"
        BASE_IMAGE="$DEV_TAG"
        if [ -s "$overlay" ]; then
            ENV_HASH="$({ sha256sum "$overlay" 2>/dev/null || shasum -a 256 "$overlay"; } | cut -c1-64)"
            TARGET_IMAGE="intentic-sandbox-dev-env-${SLUG}:$(printf '%s' "$ENV_HASH" | cut -c1-12)"
            echo "intentic: building ${TARGET_IMAGE} — the overlay's tooling on top of ${DEV_TAG}…"
            echo "== docker build ${TARGET_IMAGE} ==" >>"$LOG"
            docker build -t "$TARGET_IMAGE" - <"$overlay" 2>&1 | tee -a "$LOG" || true
        fi
        ;;
esac
if ! docker image inspect "$TARGET_IMAGE" >/dev/null 2>&1; then
    echo "error: ${TARGET_IMAGE} is not available (pull or overlay build failed) — the sandbox is untouched. Log: ${LOG}" >&2
    exit 1
fi

# ——— Ask the TARGET IMAGE for its own run command (see the header): env in, command out. ———
# The old container's env, NUL-framed, filtered against the replay allowlist inside the CLI — the same place
# the rest of the shape lives. The /agent-auth mount is a mount+env pair: replaying AGENT_AUTH_DIR without its
# volume would point the daemon at an empty container-local dir, stranding the shared credentials.
docker exec "$CONTAINER" printenv -0 >"$envdump"
MOUNTS="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/agent-auth"}}{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
[ -n "$MOUNTS" ] && MOUNTS="${MOUNTS}:/agent-auth"
# The dev wrapper binds the checkout's compiled trees over the image's baked copies (dev-mounts.mjs), so a
# daemon edit reloads in seconds instead of a rebuild — newline-separated -v specs, straight through.
if [ -n "${INTENTIC_DEV_MOUNTS:-}" ]; then
    MOUNTS="${MOUNTS:+${MOUNTS}
}${INTENTIC_DEV_MOUNTS}"
fi
RUNTIME_LINES="$(grep '^# intentic:runtime ' "$overlay" || true)"
# The resolvers the container was created with (connect.sh's SANDBOX_DNS). The hand-written recreates silently
# DROPPED these on every swap — a restricted-network sandbox lost its split-horizon config the first time its
# owner rebuilt it; replaying them through the contract is what fixes that class.
DNS_SERVERS="$(docker inspect --format '{{join .HostConfig.Dns " "}}' "$CONTAINER" 2>/dev/null || true)"

set -- --slug "$SLUG" --image "$TARGET_IMAGE" --base-image "$BASE_IMAGE"
[ -n "$DNS_SERVERS" ] && set -- "$@" --dns "$DNS_SERVERS"
[ -n "$ENV_HASH" ] && set -- "$@" --environment-hash "$ENV_HASH"
[ -n "$RUNTIME_LINES" ] && set -- "$@" --runtime "$RUNTIME_LINES"
[ -n "$MOUNTS" ] && set -- "$@" --mounts "$MOUNTS"
if ! docker run -i --rm --entrypoint intentic "$TARGET_IMAGE" sandbox run-command "$@" <"$envdump" >"$run_command" 2>>"$LOG" || ! [ -s "$run_command" ]; then
    tail -n 5 "$LOG" >&2
    echo "error: ${TARGET_IMAGE} could not produce its run command (an unsupported runtime directive, or an image" >&2
    echo "       too old to carry the run contract — run the update flow first). Log: ${LOG}" >&2
    exit 1
fi

echo "intentic: recreating the sandbox from ${TARGET_IMAGE}…"
echo "== previous container logs (${CONTAINER}) ==" >>"$LOG"
docker logs --tail 5000 "$CONTAINER" >>"$LOG" 2>&1 || true
docker rm -f "$CONTAINER" >/dev/null
echo "== run command ==" >>"$LOG"
cat "$run_command" >>"$LOG"
# The loopback shortcut (127.0.0.1:<port derived from the sandbox id>:8787, which lets a browser on this
# machine skip the tunnel) is the one part of the run that may fail without the sandbox being broken: docker
# refuses the whole launch when that port is already held. Retry once without it; any other failure fails both
# attempts and reports below. The failed attempt leaves a created-but-stopped container holding the name.
if ! sh "$run_command" >/dev/null 2>>"$LOG"; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    if ! docker run -i --rm --entrypoint intentic "$TARGET_IMAGE" sandbox run-command "$@" --no-local-publish <"$envdump" >"$run_command" 2>>"$LOG" ||
        ! [ -s "$run_command" ] || ! sh "$run_command" >/dev/null 2>>"$LOG"; then
        tail -n 5 "$LOG" >&2
        echo "error: starting the recreated sandbox failed (a runtime flag the host rejects, e.g. --privileged or /dev/net/tun?)." >&2
        echo "       The previous container's logs and this error are saved to ${LOG}. Re-run your connect one-liner to restore the stock sandbox." >&2
        exit 1
    fi
    echo "intentic: recreated without the local shortcut (its port is taken) — this browser reaches the sandbox over its tunnel."
fi

# A container that starts but crash-loops (an overlay that breaks the daemon) would otherwise read as success —
# gate on the daemon's own /health before declaring it.
echo "intentic: waiting for the sandbox daemon to come up…"
tries=0
until docker exec "$CONTAINER" curl -sf http://localhost:8787/health >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 15 ]; then
        echo "== recreated container logs (${CONTAINER}) ==" >>"$LOG"
        docker logs --tail 500 "$CONTAINER" >>"$LOG" 2>&1 || true
        echo "error: the recreated sandbox did not become healthy within 30s — its logs are saved to ${LOG}." >&2
        echo "       Re-run your connect one-liner to restore the stock sandbox." >&2
        exit 1
    fi
    sleep 2
done

case "$MODE" in
    rebuild) echo "intentic: sandbox rebuilt — the Environment card will show Applied once it reconnects." ;;
    update) echo "intentic: sandbox updated to ${TARGET_IMAGE}." ;;
    dev) echo "intentic: sandbox is live on ${TARGET_IMAGE} — docker logs -f ${CONTAINER}" ;;
esac
echo "Logs: docker logs -f ${CONTAINER} (recreate log: ${LOG})"
