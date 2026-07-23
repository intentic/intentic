#!/usr/bin/env bash
# Roll the self-hosted platform after images:platform pushes: one Komodo DeployStack call against the stack
# created from _tools/selfhost/platform (its services run :latest with pull_policy: always, so a redeploy
# pulls what CI just pushed). Deliberately inert until the CI/CD variables are configured — the images job
# calls this unconditionally and it self-skips, so enabling continuous deploy is pure configuration:
#   PLATFORM_DEPLOY_STACK   the Komodo stack name (e.g. intentic-platform)
#   KOMODO_URL              the Komodo core origin, reachable from the runner (e.g. http://192.168.0.x:9120)
#   KOMODO_API_KEY / KOMODO_API_SECRET   an api key minted in Komodo (masked CI variables)
set -euo pipefail

if [ -z "${PLATFORM_DEPLOY_STACK:-}" ] || [ -z "${KOMODO_URL:-}" ]; then
    echo "PLATFORM_DEPLOY_STACK/KOMODO_URL not set — skipping platform deploy."
    exit 0
fi

echo "deploying Komodo stack '$PLATFORM_DEPLOY_STACK'"
curl -fsS -X POST "$KOMODO_URL/execute" \
    -H "Content-Type: application/json" \
    -H "X-Api-Key: ${KOMODO_API_KEY:?}" \
    -H "X-Api-Secret: ${KOMODO_API_SECRET:?}" \
    -d "{ \"type\": \"DeployStack\", \"params\": { \"stack\": \"$PLATFORM_DEPLOY_STACK\" } }"
echo
