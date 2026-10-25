#!/usr/bin/env bash
# Before promoting sandbox tags, require the live edge's /health to declare the tunnel door this image dials; there is no fallback.
# Default door comes from this checkout; rollback passes the target release's door. A legacy response without doors implies /tunnel/v1.
# Fail closed on missing/invalid responses or incompatible doors; pipeline dependencies alone do not prove the live edge is ready.
# EDGE_HEALTH_URL selects the edge; EDGE_DOOR_WAIT defaults to 1800 seconds in CI for an in-flight roll, otherwise 0.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"

CONTRACT="_shared/sandbox-contract/src/protocol/ingress-contract.ts"
DOOR="${1:-}"
if [ -z "$DOOR" ]; then
    DOOR="$(sed -n 's/^export const INGRESS_TUNNEL_PATH = "\([^"]*\)";$/\1/p' "$(repo_root)/$CONTRACT")"
fi
if [ -z "$DOOR" ]; then
    echo >&2 "error: no INGRESS_TUNNEL_PATH in $CONTRACT, so the door this image's netd dials is unknown."
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

echo >&2 "error: the live edge does not serve $DOOR, the tunnel door this image's netd dials."
if [ "$status" -eq 1 ]; then
    echo >&2 "  $HEALTH_URL declares doors $declared."
else
    echo >&2 "  $HEALTH_URL gave no edge health answer: ${body:-(nothing)}"
fi
echo >&2 "  Moving the tag now would strand every sandbox that pulls it: a netd has no other way in."
echo >&2 "  Roll the edge first (deploy-ingress.sh, which images-platform runs on a platform push; ingress/README.md),"
echo >&2 "  then re-run this job."
exit 1
