#!/usr/bin/env bash
# Roll the EDGE after images-platform pushes it, and then prove the roll landed.
#
# THE GAP THIS CLOSES, because it cost a customer an evening and nobody noticed for ten days. The
# images-platform job builds and pushes three images — api, web, ingress — and then runs deploy-platform.sh,
# which rolls the KOMODO STACK. The api and the web are in that stack. The ingress is not: it runs on Fly
# (_platform/ingress/fly.toml), and nothing in this repository ever deployed it. `intentic-ingress` appeared
# in exactly one file, the fly.toml describing it. So `ingress:latest` moved on every push to main and the
# machines serving production kept the build they were started with; the pipeline passed each time,
# because pushing an image is what it checked.
#
# What that cost: hosted sandboxes had moved off tunnels onto `fly-replay` (at the time the daemon on a hosted
# machine dialled nothing). The edge that carried that decision was ten days older than the sandbox image and had no
# replay in it, so every hosted sandbox answered 502 at its own public name, probed itself for five minutes, and told
# its owner to start it over — which could never help, because nothing about the sandbox was wrong. (Replay is gone
# since: every sandbox dials its tunnel, reach-posture.ts, and the edge terminates TLS with no Fly proxy to replay.)
#
# So this script's contract is deploy AND VERIFY, in deploy-platform.sh's words: "a guard whose failure
# nobody is told about is the same silence it was written to end". A deploy that does not change the running
# build fails the job.
#
#   FLY_API_TOKEN     a Fly deploy token for the org the edge runs in. EMPTY MEANS SKIP, so a fork, a local
#                     run and a branch that is not production are all inert rather than broken.
#   INGRESS_IMAGE     the exact image to deploy; defaults to the `latest` this push just wrote.
#   INGRESS_APP       the Fly app, default from fly.toml's own name.
#   INGRESS_FLY_CONFIG, or the first argument
#                     which Fly config to deploy, relative to the repository root or absolute; default
#                     _platform/ingress/fly.toml, the one CI deploys on every push, where the edge terminates TLS.
#                     _platform/ingress/fly.edge-proxy.toml is the emergency fallback behind Fly's HTTP proxy, deployed
#                     only by hand and only after its prerequisites (ingress/README.md, "Rolling back").
#   INGRESS_EDGE_MODE `tls` (the default) or `proxy`: the shape this deploy is EXPECTED to roll. The shape is read off
#                     the config (one with an [http_service] sits behind Fly's proxy), and a config that disagrees fails
#                     before anything is deployed, so a fly.toml that somehow went back to the proxy shape cannot put
#                     production behind a proxy holding no certificate. Only a hand-run fallback says `proxy`.
#
# TLS MODE, the default: the edge holds the certificate and serves UDP beside it, and it must also DECLARE that on
# /health (`"transports":["quic","h3","webtransport"]`), since fronts and editors reach for QUIC and WebTransport only
# where it is declared; an edge that answers without it is one whose INGRESS_QUIC_PORT is not set, and the deploy
# fails. Success ends in one line CI's log can be checked for: `edge-mode: tls — <app> declares quic, h3 and
# webtransport`.
set -euo pipefail

if [ -z "${FLY_API_TOKEN:-}" ]; then
    echo "No FLY_API_TOKEN — skipping the edge deploy. (The edge is then whatever it already was, rolled by hand"
    echo "with flyctl; see _platform/ingress/README.md, \"Deploying\".)"
    exit 0
fi

. "$(dirname "$0")/../lib/repo-root.sh"

ROOT="$(repo_root)"
CONFIG="${1:-${INGRESS_FLY_CONFIG:-_platform/ingress/fly.toml}}"
case "$CONFIG" in
    /*) ;;
    *) CONFIG="$ROOT/$CONFIG" ;;
esac
if [ ! -f "$CONFIG" ]; then
    echo >&2 "error: no Fly config at $CONFIG"
    exit 1
fi
if grep -q '^\[http_service\]' "$CONFIG"; then
    SHAPE=proxy
else
    SHAPE=tls
fi
MODE="${INGRESS_EDGE_MODE:-tls}"
case "$MODE" in
    tls | proxy) ;;
    *)
        echo >&2 "error: INGRESS_EDGE_MODE is '$MODE'; it is tls (the default) or proxy."
        exit 1
        ;;
esac
if [ "$SHAPE" != "$MODE" ]; then
    echo >&2 "error: $(basename "$CONFIG") is the $SHAPE shape, but this deploy expects $MODE."
    if [ "$SHAPE" = proxy ]; then
        echo >&2 "  Behind Fly's HTTP proxy the edge needs a Fly certificate for *.sbx.intentic.dev, and there is none since"
        echo >&2 "  phase 3b. Falling back is by hand, with INGRESS_EDGE_MODE=proxy, after ingress/README.md \"Rolling back\"."
    fi
    exit 1
fi
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

echo "deploying $IMAGE to Fly app '$APP' (build $EXPECTED) with $(basename "$CONFIG")$([ "$SHAPE" = tls ] && echo ', terminating TLS at the edge')"
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

# AND IT SERVES THE DOOR THIS CHECKOUT'S FRONTS DIAL, which is what image publication asks of it next (ci.yml
# images-merge, the release): an edge rolled from an image that somehow lacks it fails here, where the cause is.
EDGE_HEALTH_URL="$HEALTH_URL" EDGE_DOOR_WAIT=0 bash "$ROOT/_tools/scripts/image/require-edge-door.sh"

# TERMINATING TLS, THE EDGE MUST SAY SO. The build answering above proves the process is up behind the new services;
# the declaration proves it bound the QUIC door those services send UDP to, which is what every front and editor now
# goes by. Fly accepted the UDP service either way, so nothing else here would notice an edge that never listens on it.
if [ "$SHAPE" = tls ]; then
    declared="$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null | sed -n 's/.*"transports":\[\([^]]*\)\].*/\1/p')"
    for transport in quic h3 webtransport; do
        case "$declared" in
            *"\"$transport\""*) ;;
            *)
                echo >&2 "error: $APP terminates TLS under $(basename "$CONFIG") but its /health declares [${declared}], not $transport."
                echo >&2 "  The edge declares what it binds: INGRESS_QUIC_PORT=443 and INGRESS_QUIC_HOST=fly-global-services"
                echo >&2 "  must be set on it ('flyctl secrets list -a $APP'). Until they are, fronts dial no QUIC and editors open"
                echo >&2 "  no WebTransport; the WebSocket still carries everything. ingress/README.md has the runbook."
                exit 1
                ;;
        esac
    done
    echo "edge-mode: tls — $APP declares quic, h3 and webtransport"
else
    echo "edge-mode: proxy — $APP sits behind Fly's HTTP proxy and declares no UDP transports"
fi
