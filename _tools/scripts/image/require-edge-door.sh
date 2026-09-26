#!/usr/bin/env bash
# REFUSE TO MOVE A SANDBOX TAG AHEAD OF THE EDGE THAT SERVES IT. Every script that points a moving tag a sandbox
# pulls (`latest` in ci.yml's images-merge, `stable` in release-images.sh and rollback-stable.sh) runs this first.
#
#   require-edge-door.sh [door]
#
# A front reaches the world through exactly one tunnel door on the edge (`INGRESS_TUNNEL_PATH`, held to the front's
# own `tunnel::TUNNEL_PATH` by wire-manifests.test.ts), and it has no fallback: an edge that does not serve that door
# answers its upgrade with a 404, and every sandbox on the new image is unreachable until the edge is redeployed.
# So the question is not "did this pipeline roll the edge" but "does the edge that is live RIGHT NOW serve the door
# this image dials", and the edge answers it itself: `/health` lists its doors (`"doors":["/tunnel/v1","/tunnel/v2"]`,
# edge.rs). That covers every way an image gets published and every way an edge gets deployed, CI or by hand, where a
# job dependency would cover one pipeline and pass on a skip.
#
# The door defaults to the one this checkout's front dials. rollback-stable.sh passes the door of the version it
# rolls back onto, since that is the front sandboxes will run.
#
# FAILS CLOSED: no answer, an answer that is not JSON, or a door list without this door is an error. An edge that
# answers without a `doors` field predates the declaration, and every such build served `/tunnel/v1` alone.
#
#   EDGE_HEALTH_URL   the live edge's /health; default the hosted one, https://ingress.sbx.intentic.dev/health.
#                     A self-hosted deployment publishing its own images names its own edge here.
#   EDGE_DOOR_WAIT    seconds to keep asking before failing; default 1800 in CI, where the edge roll of the same push
#                     (images-platform, deploy-ingress.sh) may still be in flight, and 0 elsewhere.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"

CONTRACT="_shared/sandbox-contract/src/protocol/ingress-contract.ts"
DOOR="${1:-}"
if [ -z "$DOOR" ]; then
    DOOR="$(sed -n 's/^export const INGRESS_TUNNEL_PATH = "\([^"]*\)";$/\1/p' "$(repo_root)/$CONTRACT")"
fi
if [ -z "$DOOR" ]; then
    echo >&2 "error: no INGRESS_TUNNEL_PATH in $CONTRACT, so the door this image's front dials is unknown."
    exit 1
fi
HEALTH_URL="${EDGE_HEALTH_URL:-https://ingress.sbx.intentic.dev/health}"
if [ -n "${CI:-}" ]; then
    WAIT="${EDGE_DOOR_WAIT:-1800}"
else
    WAIT="${EDGE_DOOR_WAIT:-0}"
fi

# Prints the declared doors and exits 0 when DOOR is among them; exits 1 otherwise, 2 on an answer that is not an
# edge's health.
serves_door() {
    node -e '
        const [door, body] = [process.argv[1], process.argv[2]];
        let health;
        try { health = JSON.parse(body); } catch { process.exit(2); }
        if (health === null || typeof health !== "object" || health.status !== "ok") process.exit(2);
        const doors = Array.isArray(health.doors) ? health.doors : ["/tunnel/v1"];
        console.log(JSON.stringify(doors));
        process.exit(doors.includes(door) ? 0 : 1);
    ' "$DOOR" "$1"
}

deadline=$((SECONDS + WAIT))
while :; do
    body="$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null || true)"
    status=0
    declared="$(serves_door "$body")" || status=$?
    if [ "$status" -eq 0 ]; then
        echo "the edge at $HEALTH_URL serves $DOOR (doors $declared)"
        exit 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
        break
    fi
    sleep 30
done

echo >&2 "error: the live edge does not serve $DOOR, the tunnel door this image's front dials."
if [ "$status" -eq 1 ]; then
    echo >&2 "  $HEALTH_URL declares doors $declared."
else
    echo >&2 "  $HEALTH_URL gave no edge health answer: ${body:-(nothing)}"
fi
echo >&2 "  Moving the tag now would strand every sandbox that pulls it: a front has no other way in."
echo >&2 "  Roll the edge first (deploy-ingress.sh, which images-platform runs on a platform push; ingress/README.md),"
echo >&2 "  then re-run this job."
exit 1
