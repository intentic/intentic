#!/usr/bin/env bash
# Roll the EDGE after images-platform pushes it, and then prove the roll landed.
#
# THE GAP THIS CLOSES, because it cost a customer an evening and nobody noticed for ten days. The
# images-platform job builds and pushes three images — api, web, ingress — and then runs deploy-platform.sh,
# which rolls the KOMODO STACK. The api and the web are in that stack. The ingress is not: it runs on Fly
# (_platform/ingress/fly.toml), and nothing in this repository ever deployed it. `intentic-ingress` appeared
# in exactly one file, the fly.toml describing it. So `ingress:latest` moved on every push to main and the
# machines serving production kept the build they were started with; the pipeline went green each time,
# because pushing an image is what it checked.
#
# What that cost: hosted sandboxes moved off tunnels onto `fly-replay` (the daemon on a hosted machine dials
# nothing, by design — reach-report.ts, ingress-tunnel.ts reachPosture). The edge that carries that decision
# was ten days older than the sandbox image and had no replay in it, so every hosted sandbox answered 502 at
# its own public name, probed itself for five minutes, and told its owner to start it over — which could
# never help, because nothing about the sandbox was wrong.
#
# So this script's contract is deploy AND VERIFY, in deploy-platform.sh's words: "a guard whose failure
# nobody is told about is the same silence it was written to end". A deploy that does not change the running
# build fails the job.
#
#   FLY_API_TOKEN     a Fly deploy token for the org the edge runs in. EMPTY MEANS SKIP, so a fork, a local
#                     run and a branch that is not production are all inert rather than broken.
#   INGRESS_IMAGE     the exact image to deploy; defaults to the `latest` this push just wrote.
#   INGRESS_APP       the Fly app, default from fly.toml's own name.
set -euo pipefail

if [ -z "${FLY_API_TOKEN:-}" ]; then
    echo "No FLY_API_TOKEN — skipping the edge deploy. (The edge is then whatever it already was: hosted"
    echo "sandboxes are only reachable if a build with replay in it is already running. See fly.toml.)"
    exit 0
fi

. "$(dirname "$0")/../lib/repo-root.sh"

ROOT="$(repo_root)"
CONFIG="$ROOT/_platform/ingress/fly.toml"
APP="${INGRESS_APP:-intentic-ingress}"
IMAGE="${INGRESS_IMAGE:-ghcr.io/intentic/ingress:latest}"
HEALTH_URL="${INGRESS_HEALTH_URL:-https://ingress.sbx.intentic.dev/health}"

# Cached next to the other CI caches: this is a ~30 MB download and the job container ships no flyctl.
export FLYCTL_INSTALL="${FLYCTL_INSTALL:-/ci-cache/flyctl}"
export PATH="$FLYCTL_INSTALL/bin:$PATH"
if ! command -v flyctl >/dev/null 2>&1; then
    echo "installing flyctl into $FLYCTL_INSTALL"
    curl -fsSL https://fly.io/install.sh | sh >/dev/null
fi

# WHAT THE RUNNING EDGE MUST SAY ABOUT ITSELF AFTERWARDS, read out of the image rather than recomputed here.
# docker-release.sh bakes the content-addressed tag it pushes into INGRESS_BUILD (ingress/Dockerfile ARG
# BUILD_ID), so the image is the only thing that knows this value and the deploy cannot claim a build it is
# not carrying. The pull is a no-op on the image this job just built.
docker pull -q "$IMAGE" >/dev/null
EXPECTED="$(docker image inspect "$IMAGE" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^INGRESS_BUILD=//p' | head -1)"
if [ -z "$EXPECTED" ] || [ "$EXPECTED" = "unreleased" ]; then
    echo >&2 "error: $IMAGE carries no INGRESS_BUILD, so a deploy of it could not be verified."
    echo >&2 "  docker-release.sh bakes it from the turbo hash; an image built by hand does not have it."
    exit 1
fi

echo "deploying $IMAGE to Fly app '$APP' (build $EXPECTED)"
flyctl deploy --config "$CONFIG" --app "$APP" --image "$IMAGE" --yes

# AND THEN READ IT BACK FROM THE PUBLIC ADDRESS, not from Fly's own report of the release. Fly answering
# "deployed" means its machines took the new image; it says nothing about whether the process came up and is
# the one serving this hostname, which is the only question that matters and the exact one nobody was asking.
echo "waiting for $HEALTH_URL to report build $EXPECTED"
deadline=$((SECONDS + 180))
until [ "$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null | sed -n 's/.*"build":"\([^"]*\)".*/\1/p')" = "$EXPECTED" ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then
        running="$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null || echo '(no answer)')"
        echo >&2
        echo >&2 "error: $APP is still not serving build $EXPECTED 180s after the deploy."
        echo >&2 "  /health says: $running"
        echo >&2 "  An answer with no \"build\" field at all is an edge OLDER than this change — the machines"
        echo >&2 "  never rolled. 'flyctl status -a $APP' and 'flyctl releases -a $APP' say which image each"
        echo >&2 "  machine is on; fly.toml never auto-starts or auto-stops them, so nothing rolls them but this."
        exit 1
    fi
    printf '.'
    sleep 5
done
echo
echo "$APP is serving build $EXPECTED"

# The hosted lane's own switch, warned about rather than enforced: whether this deployment HAS a hosted lane
# is the platform's fact, not this script's, and an edge with no hosted sandboxes behind it is a legitimate
# deployment. The api knows the answer and alarms on it every health sweep (hosted-health.ts `edge`), which is
# where a missing HOSTED_APP_PREFIX is caught. This line is just the early, cheap warning.
if ! curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null | grep -q '"replay":true'; then
    echo "warning: this edge reports replay:false — HOSTED_APP_PREFIX is unset on it, so hosted sandboxes"
    echo "         will answer 502 at their own addresses. Set it to match the api's, per ingress/README.md."
fi
