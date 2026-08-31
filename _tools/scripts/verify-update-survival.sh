#!/usr/bin/env bash
# Prove the update promises on a real sandbox, nightly: YOUR FILES SURVIVE EVERY SWAP, and THE WORST OUTCOME
# OF AN UPDATE IS THE SANDBOX YOU ALREADY HAD.
#
#   verify-update-survival.sh
#
# Both promises are load-bearing product claims — the update card says "your files (in /work) are kept" and
# offers a one-command rollback, and the recreate engine (_sandbox/ic/src/sandbox/recreate.rs) parks the old
# container and restores it when the new one fails health. Nothing per-push exercises any of that against real
# published images, which is exactly the kind of property that regresses in silence: a mount dropped from one
# run shape wiped the hosted fleet's /history once already (sandbox-run/index.test.ts tells that story).
#
# The drill, on the same clean dind host verify-desktop-setup.sh uses:
#
#   1. connect a sandbox on the PUBLISHED stable image — the machine a real user has today
#   2. write sentinels into /work and /history
#   3. `ic sandbox update` onto the freshly built image (:latest, what main last published)
#        → daemon healthy, sentinels intact, image actually changed
#   4. `ic sandbox rollback`
#        → daemon healthy, sentinels intact, image back where it started
#   5. `ic sandbox update` onto an image that cannot serve the daemon at all
#        → ic fails, AND the original sandbox is back up healthy with its sentinels — the parked-container
#          restore, which is the "never worse off" half of the promise
#
# Hermetic like its sibling: direct-token connect, no edge, no platform. connect.sh is read from the
# site tree rather than an installer — verify-desktop-setup.sh owns "the shipped bytes work"; this tier owns
# "the update engine keeps its promises", and building a .deb to test the update engine would couple the two
# for nothing. ic is built from this checkout via IC_BIN, the shim's own override.
set -euo pipefail
. "$(dirname "$0")/repo-root.sh"
ROOT="$(repo_root)"

START_IMAGE="${START_IMAGE:-ghcr.io/intentic/sandbox:stable}"
UPDATE_IMAGE="${UPDATE_IMAGE:-ghcr.io/intentic/sandbox:latest}"
# Runs, stays running, and will never answer /health on 8787 — the shape of a genuinely bad release.
BROKEN_IMAGE="${BROKEN_IMAGE:-alpine:3.20}"
HOST_IMAGE="${INTENTIC_HOST_IMAGE:-}"
HOSTNAME_UNDER_TEST="drill.e2e.test"
SLUG="${HOSTNAME_UNDER_TEST%%.*}"
CONTAINER="intentic-sandbox-${SLUG}"
SENTINEL="update-drill-sentinel"

WORK="$(mktemp -d)"
HOST_CONTAINER="intentic-update-drill"
cleanup() {
    docker rm -f "$HOST_CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

# ── a clean Docker host (same shape as verify-desktop-setup.sh, which explains each step) ────────────────────
echo "==> starting a clean Docker host"
if [ -z "$HOST_IMAGE" ]; then
    HOST_IMAGE="intentic-dind-host:local"
    docker build -q -t "$HOST_IMAGE" "$ROOT/_tools/dind-host" >/dev/null
fi
docker run -d --rm --name "$HOST_CONTAINER" --privileged -e DOCKER_TLS_CERTDIR="" "$HOST_IMAGE" >/dev/null
in_host() { docker exec "$HOST_CONTAINER" "$@"; }
echo -n "    waiting for the daemon"
for _ in $(seq 1 60); do
    if in_host docker info >/dev/null 2>&1; then break; fi
    echo -n "."
    sleep 1
done
echo
in_host docker info >/dev/null 2>&1 || { echo "error: the Docker daemon inside the host never came up" >&2; exit 1; }
in_host apk add --no-cache curl >/dev/null 2>&1
if [ -f "$HOME/.docker/config.json" ]; then
    in_host mkdir -p /root/.docker
    docker cp "$HOME/.docker/config.json" "$HOST_CONTAINER:/root/.docker/config.json"
fi

echo "==> building ic from this checkout"
bash "$ROOT/_tools/scripts/build-ic.sh" linux-x64
docker cp "$ROOT/_sandbox/ic/dist-bin/ic-linux-amd64" "$HOST_CONTAINER:/root/ic"
in_host chmod +x /root/ic
docker cp "$ROOT/_site/site/public/scripts/connect.sh" "$HOST_CONTAINER:/root/connect.sh"

# ── 1. a user's sandbox: the published stable image ──────────────────────────────────────────────────────────
echo "==> connecting a sandbox on $START_IMAGE"
in_host env \
    CONNECT_TOKEN="update-drill-token" \
    SANDBOX_GRANT="dummy-reachability-grant" \
    INGRESS_URL="https://ingress.e2e.test" \
    SANDBOX_HOSTNAME="$HOSTNAME_UNDER_TEST" \
    SANDBOX_IMAGE="$START_IMAGE" \
    PLATFORM_URL="https://platform.e2e.test" \
    WEB_ORIGIN="http://localhost:47145" \
    IC_BIN=/root/ic \
    sh /root/connect.sh -y

failures=0
check() { # <label> <command...>
    local label="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        echo "  ✓ $label"
    else
        echo "  ✗ $label" >&2
        failures=$((failures + 1))
    fi
}
healthy() { in_host docker exec "$CONTAINER" curl -fsS --max-time 10 localhost:8787/health; }
sentinels_intact() {
    [ "$(in_host docker exec "$CONTAINER" cat "/work/$SENTINEL" 2>/dev/null)" = "drill" ] &&
        [ "$(in_host docker exec "$CONTAINER" cat "/history/$SENTINEL" 2>/dev/null)" = "drill" ]
}
image_of() { in_host docker inspect -f '{{.Image}}' "$CONTAINER"; }

# ── 2. the user's data ───────────────────────────────────────────────────────────────────────────────────────
in_host docker exec "$CONTAINER" sh -c "printf drill > /work/$SENTINEL && printf drill > /history/$SENTINEL"
before="$(image_of)"

# ── 3. update ────────────────────────────────────────────────────────────────────────────────────────────────
echo "==> ic sandbox update → $UPDATE_IMAGE"
in_host env SANDBOX_IMAGE="$UPDATE_IMAGE" /root/ic sandbox update "$SLUG"
check "the daemon answers /health on the new image" healthy
check "the sentinels survived the update (/work and /history)" sentinels_intact
updated="$(image_of)"
check "the container actually moved to a different image" test "$before" != "$updated"

# ── 4. rollback ──────────────────────────────────────────────────────────────────────────────────────────────
echo "==> ic sandbox rollback"
in_host /root/ic sandbox rollback "$SLUG"
check "the daemon answers /health after rollback" healthy
check "the sentinels survived the rollback" sentinels_intact
check "rollback returned to the pre-update image" test "$(image_of)" = "$before"

# ── 5. an update that fails must leave the sandbox it found ──────────────────────────────────────────────────
echo "==> ic sandbox update → $BROKEN_IMAGE (must fail AND restore)"
if in_host env SANDBOX_IMAGE="$BROKEN_IMAGE" /root/ic sandbox update "$SLUG"; then
    echo "  ✗ ic reported success moving onto an image that cannot run the daemon" >&2
    failures=$((failures + 1))
else
    echo "  ✓ ic refused the broken image"
fi
check "the previous sandbox is back and answers /health" healthy
check "its sentinels are intact" sentinels_intact
check "it runs the image it ran before the failed update" test "$(image_of)" = "$before"

echo
if [ "$failures" -gt 0 ]; then
    echo "==> the update promises DID NOT hold ($failures failed assertion(s))" >&2
    exit 1
fi
echo "==> update, rollback and a failed update all kept the user's files and a working sandbox"
