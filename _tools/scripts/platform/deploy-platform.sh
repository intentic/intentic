#!/usr/bin/env bash
# Deploy the image-push stack only when PLATFORM_DEPLOY_STACK names a stack, and then prove the roll landed:
# the api answers /health, and the public web origin serves the build this job pushed.
#
# KOMODO_API_KEY and KOMODO_API_SECRET must be masked CI variables.
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
        echo "  from the migrations (CI proves the migrations themselves replay into schema.prisma), and" >&2
        echo "  'Error: P3009' means a migration FAILED against this database once and is now blocking every" >&2
        echo "  migration behind it, which no redeploy clears: _platform/prisma/README.md has the runbook." >&2
        exit 1
    fi
    printf '.'
    sleep 5
done
echo
echo "api is serving"

# AND THEN THE WEB, BY BUILD, because the check above is no evidence about it in either direction: the api and
# the web are separate containers that compose recreates one after another, behind a cloudflared recreated
# after both (docker-compose.yml depends_on). While the api answers, app.<zone> can still be the outgoing
# container or the tunnel between containers answering 502 — and the browser smoke that runs next reads either
# as a fault in the web image's own files.
#
# Same contract as deploy-ingress.sh: read the build back off the PUBLIC address, out of the image rather than
# recomputed here, so a deploy that did not land is a red job.
WEB_URL="${PLATFORM_WEB_URL:-https://app.intentic.dev}"
WEB_IMAGE="${PLATFORM_WEB_IMAGE:-ghcr.io/intentic/web:latest}"

docker pull -q "$WEB_IMAGE" >/dev/null
EXPECTED="$(docker image inspect "$WEB_IMAGE" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^WEB_BUILD=//p' | head -1)"
if [ -z "$EXPECTED" ] || [ "$EXPECTED" = "unreleased" ]; then
    echo >&2 "error: $WEB_IMAGE carries no WEB_BUILD, so a deploy of it could not be verified."
    echo >&2 "  docker-release.sh bakes it from the turbo hash; an image built by hand does not have it."
    exit 1
fi

# Case-insensitively, because the name arrives lowercased over HTTP/2 and capitalised over HTTP/1.1.
served_build() {
    curl -fsSI --max-time 10 "$WEB_URL" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "x-web-build:" { print $2 }' | head -1
}

echo "waiting for $WEB_URL to serve build $EXPECTED"
deadline=$((SECONDS + 180))
until [ "$(served_build)" = "$EXPECTED" ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then
        serving="$(served_build || true)"
        echo >&2
        echo >&2 "error: $WEB_URL is still not serving build $EXPECTED 180s after the deploy."
        echo >&2 "  It says: ${serving:-(no X-Web-Build header at all)}"
        echo >&2 "  No header at all is the tunnel's own error page — the container is not up — or a web image"
        echo >&2 "  older than this check."
        echo >&2 "  The stack pulls ':latest' with pull_policy: always, so a stuck roll is the registry, the"
        echo >&2 "  pull, or a stack pinned to another tag via INTENTIC_IMAGE_TAG. Komodo's own log for"
        echo >&2 "  '$PLATFORM_DEPLOY_STACK' says which."
        exit 1
    fi
    printf '.'
    sleep 5
done
echo
echo "$PLATFORM_DEPLOY_STACK is healthy and serving build $EXPECTED"
