#!/usr/bin/env bash
# Prove the update promises on a real sandbox, nightly: YOUR FILES SURVIVE EVERY SWAP, and THE WORST OUTCOME
# OF AN UPDATE IS THE SANDBOX YOU ALREADY HAD.
#
#   verify-update-survival.sh
#
# Both promises are load-bearing product claims — the update card says "your files (in /work) are kept" and
# offers a one-command rollback, and the recreate engine (_sandbox/ic/src/sandbox/recreate.rs) parks the old
# container, restores it when the new one fails health, and keeps it parked through a probation in which
# `ic sandbox watch` goes back to it by itself. Nothing per-push exercises any of that against real
# published images, which is exactly the kind of property that regresses in silence: a mount dropped from one
# run shape wiped the hosted fleet's /history once already (sandbox-run/index.test.ts tells that story).
#
# The drill, on the same clean dind host verify-desktop-setup.sh uses:
#
#   0. resolve the two images, and make sure they are two: when :latest and :stable name one image there is
#      nothing to move onto, so the target becomes those bytes under a marker layer (step 0 below says why).
#      Then derive two builds from the target that fail on purpose: its own bytes with the daemon's test-only
#      fault hook switched on (INTENTIC_FAULT, _sandbox/sandbox/src/system/boot/fault.ts)
#   1. connect a sandbox on the PUBLISHED stable image — the machine a real user has today
#   2. write sentinels into /work and /history
#   3. `ic sandbox update` onto the freshly built image (:latest, what main last published)
#        → daemon healthy, sentinels intact, image actually changed
#   4. `ic sandbox rollback`
#        → daemon healthy, sentinels intact, image back where it started
#   5. `ic sandbox update` onto the build whose daemon dies at boot (crash-at-boot)
#        → ic fails, AND the original sandbox is back up healthy with its sentinels, and update-outcome.json says
#          `restored` — the parked-container restore, which is the "never worse off" half of the promise
#   6. `ic sandbox update` onto the build that passes that health check and then keeps crashing
#      (crash-after-ready), with the probation cut from a day to minutes, then `ic sandbox watch` until it acts
#        → back on the image it ran before, sentinels intact, and update-outcome.json says `rolled-back` — the
#          same promise, kept for a bad release that gets past the first health check
#
# Hermetic like its sibling: direct-token connect, no edge, no platform. connect.sh is read from the
# site tree rather than an installer — verify-desktop-setup.sh owns "the shipped bytes work"; this tier owns
# "the update engine keeps its promises", and building a .deb to test the update engine would couple the two
# for nothing. ic is built from this checkout via IC_BIN, the shim's own override.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
. "$(dirname "$0")/../lib/dind-host.sh"
# The two pulls below are this drill's only conversation with ghcr.io; registry-retry.sh decides which
# failures are the wire's rather than a verdict, and only those are asked again.
. "$(dirname "$0")/../lib/registry-retry.sh"
ROOT="$(repo_root)"

START_IMAGE="${START_IMAGE:-ghcr.io/intentic/sandbox:stable}"
UPDATE_IMAGE="${UPDATE_IMAGE:-ghcr.io/intentic/sandbox:latest}"
# The images step 0 derives from the target, inside the host. The marker is those bytes under a label; the other two
# are the shape of a genuinely bad release, made from the daemon :latest ships so it is that daemon's hook they turn
# on: one dies at boot before it converges the stored files, one comes up, passes the health check, and exits 20
# seconds later, every time.
DRILL_IMAGE="intentic-sandbox:update-drill"
CRASH_AT_BOOT_IMAGE="intentic-sandbox:update-drill-crash-at-boot"
CRASH_AFTER_READY_IMAGE="intentic-sandbox:update-drill-crash-after-ready"
# Step 6's probation, cut from a day, and how long a new version may go unready or unreachable before `ic sandbox
# watch` gives up on it (ic reads both; production never sets them). The probation has to outlast the first crash
# (20s after ready) and the grace after it by a wide margin, or the watch would call the probation over and KEEP the
# crashing build: the drill would be judging a race rather than the rollback.
PROBATION_ENV=(IC_PROBATION_SECONDS=240 IC_WATCH_GRACE_SECONDS=20)
# How long step 6 keeps asking `ic sandbox watch` for its verdict: a hang bound, far above the minute it takes, and
# past the end of the probation above in case the verdict is only given there.
WATCH_BOUND_SECONDS=420
HOSTNAME_UNDER_TEST="drill.e2e.test"
SLUG="${HOSTNAME_UNDER_TEST%%.*}"
CONTAINER="intentic-sandbox-${SLUG}"
SENTINEL="update-drill-sentinel"

WORK="$(mktemp -d)"
HOST_CONTAINER="intentic-update-drill"
cleanup() {
    # The derived images live only inside the host, and go with it; removed by name first all the same, so a host
    # whose storage outlives it keeps nothing of this run's. `docker exec`, not in_host: this also runs when the
    # host never started. Bounded, because it asks the host's own daemon, and one wedged mid-drill must not keep
    # the host below from being removed.
    timeout 60 docker exec "$HOST_CONTAINER" docker rmi -f "$CRASH_AT_BOOT_IMAGE" "$CRASH_AFTER_READY_IMAGE" "$DRILL_IMAGE" >/dev/null 2>&1 || true
    docker rm -f "$HOST_CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

# a clean Docker host (lib/dind-host.sh, shared with verify-desktop-setup.sh)
start_dind_host "$HOST_CONTAINER"

echo "==> building ic from this checkout"
bash "$ROOT/_tools/scripts/build/build-ic.sh" linux-x64
docker cp "$ROOT/_sandbox/ic/dist-bin/ic-linux-amd64" "$HOST_CONTAINER:/root/ic"
in_host chmod +x /root/ic
docker cp "$ROOT/_site/site/public/scripts/connect.sh" "$HOST_CONTAINER:/root/connect.sh"

# 0. TWO DIFFERENT IMAGES TO MOVE BETWEEN
# `:stable` and `:latest` are the SAME image whenever main has published nothing since the last release
# promoted one onto the other. That is a normal registry state, not a broken one, and `ic` reports it
# correctly ("no newer sandbox image is available yet — your sandbox is already on the latest :stable it can
# pull"). The drill used to read that correct no-op as a broken update engine: step 3's "the container
# actually moved" failed, and then step 4's rollback had no record to roll back to and took the whole script
# down with it under `set -e`, so steps 4 and 5 — including the parked-container restore, the most valuable
# assertion here — never ran at all. The 2026-09-09 nightly failed exactly that way.
#
# So the pair is resolved before anything is connected, and when the two tags name one image the target
# becomes a derivative of it: the same published bytes under a marker layer, which is a different image id for
# the engine to move onto while running exactly the daemon `:latest` ships.
#
# Every derivative here is the target's bytes with one Dockerfile instruction laid over them, as `FROM <target>` plus
# that line would make it. Made with `docker commit` rather than a one-line Dockerfile because the dind host carries
# the docker CLI and compose, not buildx, and a `docker build` there would be a second thing that can fail for
# reasons the update engine knows nothing about. No command argument: the created container inherits the image's
# own entrypoint and cmd, and `commit` carries them into the derivative — a `docker create IMAGE true` here would
# bake `true` in as the CMD and hand the update engine an image whose daemon never starts.
derive_image() { # <from> <tag> <instruction>
    local created
    created="$(in_host docker create "$1")"
    in_host docker commit --change "$3" "$created" "$2" >/dev/null
    in_host docker rm -v "$created" >/dev/null
}
echo "==> resolving $START_IMAGE and $UPDATE_IMAGE"
for image in "$START_IMAGE" "$UPDATE_IMAGE"; do
    # registry_retry, not image_pull: the dind host is created fresh above, so its image store cannot be
    # holding the half-unpacked layer that helper exists to drop.
    if ! registry_retry in_host docker pull -q "$image"; then
        echo "error: could not pull $image — the drill has no pair of images to move between, and nothing below" >&2
        echo "       would be a statement about the update engine. The registry kept refusing or dropping the" >&2
        echo "       pull, so this is the registry or this host's login." >&2
        exit 1
    fi
done
image_id_of() { in_host docker image inspect -f '{{.Id}}' "$1"; }
if [ "$(image_id_of "$START_IMAGE")" = "$(image_id_of "$UPDATE_IMAGE")" ]; then
    echo "    $UPDATE_IMAGE is the same image as $START_IMAGE — main has published nothing since the last"
    echo "    promotion. Updating onto $DRILL_IMAGE instead: those bytes under a marker layer, so the drill"
    echo "    still exercises a real move rather than asserting against a correct no-op."
    derive_image "$UPDATE_IMAGE" "$DRILL_IMAGE" 'LABEL dev.intentic.update-drill=1'
    UPDATE_IMAGE="$DRILL_IMAGE"
fi

# THE BUILDS THAT FAIL ON PURPOSE. A bad release has to get as far as the cutover for the restore and the probation
# to be exercised at all. Step 5 used to update onto alpine, which cannot even print a run command, so ic refused it
# before anything was parked and the restore it claimed to prove never ran. These are the target itself with the
# daemon's fault hook on, so the swap parks the old container, starts the new one, and meets a failure a real
# release could have. A daemon from before the hook ignores it, which steps 5 and 6 then report as a failed drill.
echo "==> deriving the builds that fail on purpose from $UPDATE_IMAGE"
derive_image "$UPDATE_IMAGE" "$CRASH_AT_BOOT_IMAGE" 'ENV INTENTIC_FAULT=crash-at-boot'
derive_image "$UPDATE_IMAGE" "$CRASH_AFTER_READY_IMAGE" 'ENV INTENTIC_FAULT=crash-after-ready'

# 1. a user's sandbox: the published stable image
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
# `check` runs a predicate; `step` runs the thing the predicates are ABOUT. Counted rather than fatal, because
# under `set -e` a bare `ic` call that exits non-zero takes every assertion after it down too — and the ones
# after it are the point. A rollback with nothing to roll back to once cost this tier steps 4 AND 5, so the run
# reported a single unexplained exit where it had three assertions' worth of evidence to hand over.
step() { # <label> <command...>
    local label="$1"
    shift
    "$@" || {
        echo "  ✗ $label" >&2
        failures=$((failures + 1))
    }
}
healthy() { in_host docker exec "$CONTAINER" curl -fsS --max-time 10 localhost:8787/health; }
# A container ic has just put back boots before it answers: the restore renames the parked container and starts it,
# and ic returns without waiting on it. `healthy` alone would race that boot. A deadline rather than a count, since
# one probe may itself take ten seconds.
healthy_soon() {
    local deadline=$((SECONDS + 180))
    until healthy >/dev/null 2>&1; do
        [ "$SECONDS" -lt "$deadline" ] || return 1
        sleep 3
    done
}
sentinels_intact() {
    [ "$(in_host docker exec "$CONTAINER" cat "/work/$SENTINEL" 2>/dev/null)" = "drill" ] &&
        [ "$(in_host docker exec "$CONTAINER" cat "/history/$SENTINEL" 2>/dev/null)" = "drill" ]
}
image_of() { in_host docker inspect -f '{{.Image}}' "$CONTAINER"; }
# What ic last told the sandbox it did about its version (/history/update-outcome.json, on the volume every version
# of it shares): the `result`, or nothing while no running container can be asked. Never fails, so an assignment
# under `set -e` can read it mid-swap. ic writes the file compact; the pattern allows spaces all the same.
OUTCOME="/history/update-outcome.json"
outcome_result() {
    in_host docker exec "$CONTAINER" cat "$OUTCOME" 2>/dev/null | sed -n 's/.*"result" *: *"\([^"]*\)".*/\1/p' || true
}

# 2. the user's data
in_host docker exec "$CONTAINER" sh -c "printf drill > /work/$SENTINEL && printf drill > /history/$SENTINEL"
before="$(image_of)"

# 3. update
echo "==> ic sandbox update → $UPDATE_IMAGE"
step "ic sandbox update refused to run at all" in_host env SANDBOX_IMAGE="$UPDATE_IMAGE" /root/ic sandbox update "$SLUG"
check "the daemon answers /health on the new image" healthy
check "the sentinels survived the update (/work and /history)" sentinels_intact
updated="$(image_of)"
check "the container actually moved to a different image" test "$before" != "$updated"

# 4. rollback
echo "==> ic sandbox rollback"
step "ic sandbox rollback refused to run at all" in_host /root/ic sandbox rollback "$SLUG"
check "the daemon answers /health after rollback" healthy
check "the sentinels survived the rollback" sentinels_intact
check "rollback returned to the pre-update image" test "$(image_of)" = "$before"

# 5. an update that fails must leave the sandbox it found
echo "==> ic sandbox update → a build whose daemon dies at boot (must fail AND restore)"
if in_host env SANDBOX_IMAGE="$CRASH_AT_BOOT_IMAGE" /root/ic sandbox update "$SLUG"; then
    echo "  ✗ ic reported success moving onto a build whose daemon never comes up" >&2
    failures=$((failures + 1))
else
    echo "  ✓ ic gave the failed update up"
fi
check "the previous sandbox is back and answers /health" healthy_soon
check "its sentinels are intact" sentinels_intact
check "it runs the image it ran before the failed update" test "$(image_of)" = "$before"
# The proof the cutover happened at all: only the restore of a parked container says `restored`. A refusal before
# anything was parked (what this step used to exercise) leaves the file as step 4 wrote it.
check "update-outcome.json says the swap was undone (restored)" test "$(outcome_result)" = restored

# 6. a version that passes the health check and then keeps crashing must be rolled back by the probation
echo "==> ic sandbox update → a build that crashes 20s after it is ready (probation cut to minutes)"
step "ic sandbox update refused a build that passes its health check" \
    in_host env "${PROBATION_ENV[@]}" SANDBOX_IMAGE="$CRASH_AFTER_READY_IMAGE" /root/ic sandbox update "$SLUG"
check "the build was taken: it passed the first health check, and only the probation can catch it" \
    test "$(image_of)" = "$(image_id_of "$CRASH_AFTER_READY_IMAGE")"
echo "==> ic sandbox watch, until it acts (at most ${WATCH_BOUND_SECONDS}s)"
# What the machine agent does every minute, done every few seconds. Watch's own exit status is not read: acting and
# finding nothing to do are both ordinary answers, and what it did is what the sandbox is told, which is the verdict.
watch_deadline=$((SECONDS + WATCH_BOUND_SECONDS))
verdict=""
while [ "$SECONDS" -lt "$watch_deadline" ]; do
    in_host env "${PROBATION_ENV[@]}" /root/ic sandbox watch "$SLUG" 2>&1 | sed 's/^/    watch: /' || true
    verdict="$(outcome_result)"
    # `updated` is step 6's own swap, and nothing is a container mid-crash; anything else is the watch's verdict.
    case "$verdict" in rolled-back | kept | restored) break ;; esac
    sleep 5
done
echo "    $OUTCOME: $(in_host docker exec "$CONTAINER" cat "$OUTCOME" 2>/dev/null || echo "(unreadable)")"
check "ic sandbox watch rolled the crashing build back by itself (update-outcome.json: rolled-back)" \
    test "$verdict" = rolled-back
check "the previous sandbox is back and answers /health" healthy_soon
check "its sentinels are intact" sentinels_intact
check "it runs the image it ran before the bad update" test "$(image_of)" = "$before"

echo
if [ "$failures" -gt 0 ]; then
    echo "==> the update promises DID NOT hold ($failures failed assertion(s))" >&2
    exit 1
fi
echo "==> update, rollback, a failed update and a bad version on probation all kept the user's files and a working sandbox"
