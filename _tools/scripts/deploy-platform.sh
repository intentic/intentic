#!/usr/bin/env bash
# Roll the self-hosted platform after images-platform pushes: one Komodo DeployStack call against the stack
# created from _tools/selfhost/platform (its services run :latest with pull_policy: always, so a redeploy
# pulls what CI just pushed).
#
# PLATFORM_DEPLOY_STACK is set per-branch by the images-platform job in .github/workflows/ci.yml; an empty value means "do not auto-deploy",
# so a manual/local run of the images job is inert. The Komodo core origin is baked in here (override with a
# KOMODO_URL CI variable), leaving the api key the only configuration:
#   KOMODO_API_KEY / KOMODO_API_SECRET   an api key minted in Komodo (masked CI variables)
set -euo pipefail

if [ -z "${PLATFORM_DEPLOY_STACK:-}" ]; then
    echo "No PLATFORM_DEPLOY_STACK set for this branch — skipping platform deploy."
    exit 0
fi

KOMODO_URL="${KOMODO_URL:-https://komodo.radarsu.com}"

echo "deploying Komodo stack '$PLATFORM_DEPLOY_STACK' (version ${DEPLOY_VERSION:-unknown})"
curl -fsS -X POST "$KOMODO_URL/execute" \
    -H "Content-Type: application/json" \
    -H "X-Api-Key: ${KOMODO_API_KEY:?}" \
    -H "X-Api-Secret: ${KOMODO_API_SECRET:?}" \
    -d "{ \"type\": \"DeployStack\", \"params\": { \"stack\": \"$PLATFORM_DEPLOY_STACK\" } }"
echo

# AND THEN WAIT FOR IT, because DeployStack answers as soon as Komodo has accepted the request — which this
# script used to treat as the deploy having worked. Everything that can go wrong after that point went
# unreported: an image that will not start, a migration that fails, and now the schema check the api image runs
# before it serves anything (see _platform/api/Dockerfile), which is DESIGNED to stop the container. A guard
# whose failure nobody is told about is the same silence it was written to end, so the job that rolled the
# deploy is the one that has to go red.
#
# /health is the api's own readiness — it answers only after the boot chain completed, and it touches the
# database, so it cannot come back green over a container that failed the schema check. The first seconds are
# given away deliberately: the OLD container is still answering until compose replaces it, so polling
# immediately would accept the outgoing one as proof the incoming one is fine.
HEALTH_URL="${PLATFORM_HEALTH_URL:-https://api.intentic.dev/health}"
if [ "${PLATFORM_DEPLOY_WAIT:-1}" != "1" ]; then
    echo "PLATFORM_DEPLOY_WAIT=0 — not waiting for $HEALTH_URL"
    exit 0
fi

echo "waiting for $HEALTH_URL (the api serves it only once migrations applied and the schema matched)"
sleep 15
deadline=$((SECONDS + 180))
until curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null 2>&1; do
    if [ "$SECONDS" -ge "$deadline" ]; then
        echo >&2
        echo "error: $PLATFORM_DEPLOY_STACK did not come back healthy within 180s of the deploy." >&2
        echo "  The api container runs 'migrate deploy' and then a schema-vs-datamodel check before it serves." >&2
        echo "  Read its logs for which one it stopped on — a schema difference means the DATABASE has drifted" >&2
        echo "  from the migrations (CI proves the migrations themselves replay into schema.prisma)." >&2
        exit 1
    fi
    printf '.'
    sleep 5
done
echo
echo "$PLATFORM_DEPLOY_STACK is healthy"
