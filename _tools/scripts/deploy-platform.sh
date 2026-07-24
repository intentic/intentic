#!/usr/bin/env bash
# Roll the self-hosted platform after images:platform pushes: one Komodo DeployStack call against the stack
# created from _tools/selfhost/platform (its services run :latest with pull_policy: always, so a redeploy
# pulls what CI just pushed).
#
# PLATFORM_DEPLOY_STACK is set per-branch in .gitlab-ci.yml rules; an empty value means "do not auto-deploy",
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
