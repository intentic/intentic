#!/bin/sh
# intentic recreate — swap THIS machine's sandbox container onto a different image, preserving /work,
# /history, the tunnel, and every setting the container carries. One script, three ways in, because the three
# were always one flow with different pre-steps:
#
#   curl -fsSL https://intentic.dev/rebuild | sh -s -- <SLUG> <SHA256>   # rebuild: the owner-approved overlay
#   curl -fsSL https://intentic.dev/update  | sh -s -- <SLUG>            # update: the fresh :stable base
#   sh recreate.sh --dev [SLUG]                                          # dev: the locally-built dev image
#
# Optional env: INTENTIC_SET_ENV — NAME=VALUE lines to change in the recreated container (see below).
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
#
# The two flags are distinguishable from a hash by their leading `--`, which is what lets them share the second
# position with it — a sha256 is 64 hex characters and can never start that way.
MODE=""
SLUG=""
WANT_HASH=""
WANT_CHANNEL=""
case "${1:-}" in
    --dev)
        MODE="dev"
        # The slug is OPTIONAL here and required nowhere else: a dev machine usually runs exactly one sandbox, so
        # the auto-detect below is the ergonomic default — but a machine running several (dogfooding a branch
        # beside main) has no other way to say WHICH one this swap is for, and guessing would recreate somebody
        # else's session out from under it.
        SLUG="${2:-}"
        ;;
    "")
        echo "usage: recreate.sh <slug> [sha256-of-approved-overlay]" >&2
        echo "       recreate.sh <slug> --channel <tag>   # move onto a release channel and stay there" >&2
        echo "       recreate.sh <slug> --rollback        # back to the image this sandbox came from" >&2
        echo "       recreate.sh --dev [slug]             # slug optional while this machine runs one sandbox" >&2
        exit 1
        ;;
    *)
        SLUG="$1"
        case "${2:-}" in
            "") MODE="update" ;;
            --rollback) MODE="rollback" ;;
            --channel)
                MODE="update"
                WANT_CHANNEL="${3:-}"
                if [ -z "$WANT_CHANNEL" ]; then
                    echo "error: --channel needs a tag, e.g. --channel stable" >&2
                    exit 1
                fi
                ;;
            --*)
                echo "error: unknown option ${2}" >&2
                exit 1
                ;;
            *)
                MODE="rebuild"
                WANT_HASH="$2"
                ;;
        esac
        ;;
esac

if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is required — run this on the machine that runs the sandbox." >&2
    exit 1
fi

if [ "$MODE" = "dev" ] && [ -z "$SLUG" ]; then
    # Auto-detect the single sandbox container (exclude the tunnel sidecar); refuse to guess between several.
    # `ps -a`, not `ps`: the dogfood loop's whole point is replacing a daemon that just broke, and a daemon that
    # broke badly enough (a missing dependency, a bad overlay) left its container EXITED. Requiring it to be
    # running made the one flow that could fix it the one flow you could not reach.
    matches="$(docker ps -a --filter 'name=^intentic-sandbox-' --format '{{.Names}}' | grep -v -- '-tunnel-' || true)"
    count="$(printf '%s\n' "$matches" | grep -c . || true)"
    if [ "$count" -ne 1 ]; then
        if [ "$count" -eq 0 ]; then
            echo "error: no sandbox container found — run connect.sh first." >&2
        else
            # Named, not numbered: the answer is to re-run this with one of these slugs, so print what to type.
            echo "error: this machine runs more than one sandbox — name the one to swap, 'recreate.sh --dev <slug>':" >&2
            printf '%s\n' "$matches" | sed 's/^intentic-sandbox-/  /' >&2
        fi
        exit 1
    fi
    SLUG="${matches#intentic-sandbox-}"
fi
CONTAINER="intentic-sandbox-${SLUG}"
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
    echo "error: sandbox container ${CONTAINER} does not exist on this machine — re-run connect first." >&2
    exit 1
fi

# ——— The channel record: which tag this sandbox follows, and what it was on before. ———
#
# Both facts live HERE, on the machine that runs the container, because both are about a swap this script
# performed and neither survives one otherwise: the container's env carries the image it is running, and
# `docker rm -f` below is the moment the previous one stops being knowable at all. Writing it down before that
# rm is the whole of what makes a bad update reversible — until now the only way back from one was to re-run
# the connect wizard, which is a heavier answer than the problem deserves.
#
# A plain KEY=VALUE file rather than JSON: this script runs on whatever the user's machine has, and it already
# refuses to assume jq (see boot_step below).
RECORD="${INTENTIC_HOME:-$HOME/.intentic}/sandbox-${SLUG}.channel"
record_value() {
    [ -f "$RECORD" ] || return 0
    sed -n "s/^$1=//p" "$RECORD" | tail -n 1
}
# The tag this sandbox follows. An explicit --channel wins and is remembered; otherwise the remembered one, and
# `stable` for a sandbox that predates this file — which is what every existing sandbox is already on.
CHANNEL="${WANT_CHANNEL:-$(record_value channel)}"
CHANNEL="${CHANNEL:-stable}"
# SANDBOX_IMAGE still overrides everything, unchanged: it is how a pinned or locally-built image is passed in,
# and a channel is a default rather than a policy.
if [ -z "${SANDBOX_IMAGE:-}" ] && [ "$MODE" = "update" ]; then
    REGISTRY_IMAGE="registry.gitlab.com/radarsu/intentic/sandbox:${CHANNEL}"
fi

# Everything this script reads off the OLD container is read WITHOUT `docker exec`, so a crashed sandbox is
# still recreatable (see the ps -a note above): `docker cp` and `docker inspect` both work on a stopped
# container. The env comes from .Config.Env — the values `docker run` was given plus the image's own ENV, which
# is precisely what the run contract replays — NUL-framed via the template, because HOST_SSH_KEY is multi-line.
container_env_dump() {
    docker inspect --format "{{range .Config.Env}}{{.}}{{printf \"\x00\"}}{{end}}" "$CONTAINER"
}
container_env() {
    container_env_dump | tr '\0' '\n' | sed -n "s/^$1=//p" | head -n 1
}

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
envmerged="$(mktemp)"
run_command="$(mktemp)"
trap 'rm -f "$overlay" "$envdump" "$envmerged" "$run_command"' EXIT
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
    rollback)
        ROLLBACK_IMAGE="$(record_value previous)"
        if [ -z "$ROLLBACK_IMAGE" ]; then
            echo "error: nothing to roll back to — this sandbox has not been updated since the rollback record existed." >&2
            echo "       The record is written on every update from now on; ${RECORD}" >&2
            exit 1
        fi
        REGISTRY_IMAGE="$ROLLBACK_IMAGE"
        # NO pull, and no "is there anything newer" check. The point of a rollback is to reach an image that is
        # already on this machine — usually one the registry has since moved the tag away from, so a pull would
        # at best be a no-op and at worst fetch the very build being rolled back from.
        if ! docker image inspect "$REGISTRY_IMAGE" >/dev/null 2>&1; then
            echo "intentic: ${REGISTRY_IMAGE} is not on this machine any more — pulling it…"
            pull_image "$REGISTRY_IMAGE" 2>&1 | tee -a "$LOG" || true
        fi
        echo "intentic: rolling back to ${REGISTRY_IMAGE}…"
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
        docker cp "${CONTAINER}:${APPROVED_FILE}" "$overlay" >/dev/null 2>&1 || : >"$overlay"
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
    CURRENT_BASE="$(container_env SANDBOX_BASE_IMAGE || true)"
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
    # One arm, because a rollback IS an update pointed at an older tag: same overlay rebuild, same base
    # pinning, same health gate. Only where REGISTRY_IMAGE came from differs, and that was settled above.
    update | rollback)
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
container_env_dump >"$envdump"
# A container's env is fixed for its life, so REPLAYING it means every value in the allowlist is immutable
# until the owner re-runs the whole connect wizard — which is a heavy price for changing one string, and an
# impossible one for a value that did not exist when the container was created (WEB_ORIGIN is the case that
# taught us: a sandbox built before the daemon had a CORS allowlist can never gain one, so its owner's own
# self-hosted web app stays locked out). INTENTIC_SET_ENV is the escape hatch — NAME=VALUE per line, and only
# the run contract's allowlist survives, so nothing else in the caller's shell can leak into the container:
#
#   INTENTIC_SET_ENV='WEB_ORIGIN=https://localhost:47145' sh recreate.sh --dev
#
# PREPENDED, because the contract resolves each name to its FIRST occurrence — so what the caller asked for
# beats what the old container carried, and the new value is what the NEXT recreate replays.
if [ -n "${INTENTIC_SET_ENV:-}" ]; then
    { printf '%s\n' "$INTENTIC_SET_ENV" | tr '\n' '\0'; cat "$envdump"; } >"$envmerged"
    cp "$envmerged" "$envdump"
fi
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

# What this swap replaces — recorded now, while the old container is still here to be asked, and forwarded so
# the daemon can name it on the Update card ("Roll back to …"). A first-ever recreate has no previous base and
# passes none; the daemon then offers no rollback, which is the honest answer.
PREVIOUS_IMAGE="$(container_env SANDBOX_BASE_IMAGE || true)"
set -- --slug "$SLUG" --image "$TARGET_IMAGE" --base-image "$BASE_IMAGE" --channel "$CHANNEL"
[ -n "$PREVIOUS_IMAGE" ] && set -- "$@" --previous-image "$PREVIOUS_IMAGE"
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

# Written BEFORE the rm, because the rm is what makes the old base unknowable — asking after it is asking a
# container that no longer exists. Written before the LAUNCH too, deliberately: a swap that starts and then
# crash-loops is exactly the case rollback is for, and a record only written on success would be missing at the
# one moment it is needed.
#
# A ROLLBACK SWAPS THE PAIR rather than appending, so pressing it twice returns you to where you started instead
# of walking backwards through history one release at a time. That is the behaviour a single button has to have:
# there is nowhere in the UI to say "how far back".
#
# Temp-then-mv, like every other record this repo writes: a reader landing mid-write must see the whole previous
# file or the whole next one, never a seam (store/json-file.ts makes the argument at length).
# Resolved BEFORE the block below, not inside it. A conditional as the block's last statement makes the block's
# exit status that condition's — so on the one case with nothing to carry (a first-ever swap, no previous
# image, no prior record) the `&&` would fail and the record would silently not be written at all. That is the
# sandbox whose next update has no channel and no way back: the exact case this whole record exists for.
if [ "$MODE" = "rollback" ]; then
    # Rolling back makes the image we are LEAVING the thing to come back to.
    NEXT_PREVIOUS="$(record_value current)"
elif [ -n "$PREVIOUS_IMAGE" ] && [ "$PREVIOUS_IMAGE" != "$BASE_IMAGE" ]; then
    NEXT_PREVIOUS="$PREVIOUS_IMAGE"
else
    # An unchanged base (a rebuild, a re-run of the same update) leaves the rollback target where it was —
    # overwriting it with the image we are already on would quietly turn the button into a no-op.
    NEXT_PREVIOUS="$(record_value previous)"
fi
mkdir -p "$(dirname "$RECORD")"
{
    printf 'channel=%s\n' "$CHANNEL"
    printf 'current=%s\n' "$BASE_IMAGE"
    if [ -n "$NEXT_PREVIOUS" ]; then
        printf 'previous=%s\n' "$NEXT_PREVIOUS"
    fi
} >"${RECORD}.tmp" && mv "${RECORD}.tmp" "$RECORD"

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
#
# Two waits, because a daemon that ANSWERS is not yet a daemon that SERVES: it listens the moment the process
# can (so a restart stops reading as an outage) and converges its state behind a readiness gate, during which
# every route but /health and /events parks. Returning here at the first 200 handed the user a prompt back and
# a browser that would sit on its first click, so the second wait holds until /health reports `"ready":true`
# and echoes the step it is on meanwhile — the same chain the browser's warm-up screen shows.
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

# The running step's label, or empty once the chain is done. Parsed with grep/sed rather than a JSON tool: this
# script runs on whatever the user's machine has, and jq is not a given. Splitting on `{` puts each step object
# on its own line, so the line carrying "state":"running" is the same one carrying its label. A daemon too old
# to report a boot answers neither field, which reads as "no step running, ready" — the old single-wait behaviour.
boot_step() {
    docker exec "$CONTAINER" curl -sf http://localhost:8787/health 2>/dev/null |
        tr '{' '\n' | grep -F '"state":"running"' | sed -n 's/.*"label":"\([^"]*\)".*/\1/p' | head -n 1
}
boot_ready() {
    docker exec "$CONTAINER" curl -sf http://localhost:8787/health 2>/dev/null | grep -qF '"ready":false' && return 1
    return 0
}
waited=0
last_step=""
while ! boot_ready; do
    step="$(boot_step)"
    if [ -n "$step" ] && [ "$step" != "$last_step" ]; then
        echo "intentic:   ${step}…"
        last_step="$step"
    fi
    waited=$((waited + 1))
    # No hard failure: a slow boot is a slow boot, not a broken sandbox, and the daemon is already reachable.
    # Past two minutes say so and hand the prompt back rather than holding the terminal indefinitely.
    if [ "$waited" -ge 120 ]; then
        echo "intentic: the daemon is still warming up after 2 minutes — it keeps going in the background."
        echo "          Watch it with: docker logs -f ${CONTAINER}"
        break
    fi
    sleep 1
done

case "$MODE" in
    rebuild) echo "intentic: sandbox rebuilt — the Environment card will show Applied once it reconnects." ;;
    update)
        echo "intentic: sandbox updated to ${TARGET_IMAGE} (channel ${CHANNEL})."
        # Named on success, not only in the failure paths: a bad build is usually one that STARTS, and the
        # moment to learn the way back is before anyone needs it.
        [ -n "$PREVIOUS_IMAGE" ] && echo "          Roll back with: sh recreate.sh ${SLUG} --rollback"
        ;;
    rollback) echo "intentic: sandbox rolled back to ${TARGET_IMAGE} — run --rollback again to return." ;;
    dev) echo "intentic: sandbox is live on ${TARGET_IMAGE} — docker logs -f ${CONTAINER}" ;;
esac
echo "Logs: docker logs -f ${CONTAINER} (recreate log: ${LOG})"
