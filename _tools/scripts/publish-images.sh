#!/usr/bin/env bash
# Build + push the first-party intentic images to the repo's GitLab Container Registry (registry.gitlab.com/radarsu/intentic/*):
#   sandbox    the AI-agent workspace daemon + CLI
#   dind-host  a Docker-in-Docker + sshd deploy-target "host" — connect.ps1 stands one up on Windows so a
#              server-less user can deploy locally (the e2e harness + intentic-local.sh use the same recipe)
# Used by CI — the Images workflow (latest + commit SHA on push to main) and the release (the version + the
# moving `stable` tag, via semantic-release successCmd) — and runnable by hand:
#   docker login registry.gitlab.com && TAGS=0.1.0 pnpm publish:images
# TAGS is a space-separated tag list; every listed tag is pushed. On release the moving `stable` tag is pushed
# onto the new version; _libs/state-resolver/src/lib/images.ts and the connect scripts reference `sandbox:stable`
# (unpinned — always the latest release, no digest to maintain). The GitLab Container Registry packages must be made public once so
# tenant hosts can pull them unauthenticated.
set -euo pipefail

TAGS="${TAGS:?set TAGS (space-separated, e.g. "0.1.0" or "latest sha-abc1234")}"
REGISTRY="registry.gitlab.com/radarsu/intentic"
# Monorepo root (_tools/scripts -> up two). The sandbox image's build context is the whole monorepo so
# `pnpm install --frozen-lockfile` resolves the root lockfile; `pnpm deploy` prunes the final image to core.
root="$(cd "$(dirname "$0")/../.." && pwd)"

# A docker-container buildx builder. The default `docker` driver exports no cache beyond inline and pushes
# over an untested path here, so this stays — but it is best-effort: a build must NEVER fail over builder setup.
setup_builder() {
    command -v docker >/dev/null || return 0
    docker buildx inspect intentic-cache >/dev/null 2>&1 && { docker buildx use intentic-cache; return 0; }
    # dind serves docker over TLS; the docker-container driver can't read those certs from env vars, only from
    # a named context (that's the "could not create a builder instance with TLS data" error). Build one.
    local ctx=default
    if [ -n "${DOCKER_CERT_PATH:-}" ] && [ -n "${DOCKER_HOST:-}" ]; then
        docker context create intentic-dind \
            --docker "host=${DOCKER_HOST},ca=${DOCKER_CERT_PATH}/ca.pem,cert=${DOCKER_CERT_PATH}/cert.pem,key=${DOCKER_CERT_PATH}/key.pem" >/dev/null 2>&1 || true
        docker context inspect intentic-dind >/dev/null 2>&1 && ctx=intentic-dind
    fi
    docker buildx create --name intentic-cache --driver docker-container --bootstrap --use "$ctx" >/dev/null 2>&1 \
        || echo "  note: docker-container builder unavailable; using the default builder" >&2
}
setup_builder

# Build + push one image under every requested tag. The Dockerfile + build context differ per image: the
# sandbox builds from the monorepo root plus the pre-built `trees` context; the dind-host from its
# self-contained _tools/dind-host package. Extra args after the context pass through to buildx.
#
# The layer cache rides on the image being pushed anyway: `--cache-to type=inline` records the layer cache keys
# in the image config, and the next build reads them back through `--cache-from` on the published tags. Both
# Dockerfiles here are SINGLE-stage — the monorepo is compiled OUTSIDE Docker by prepare-image-trees.sh and
# enters as the `trees` context — so the pushed image already contains every layer worth caching, and inline
# covers the identical layer set a separate mode=max ref would.
#
# It covers that set far more reliably. A separate `type=registry,ref=…:buildcache` meant a SECOND ~1.5 GB
# upload, and gitlab.com's registry answers the finalizing PUT of its largest blob with a 400; buildkit then
# cancels the image push running alongside it, so a fully-pushed image got thrown away — that is how 1.159.0
# and 1.160.0 reached npm with no sandbox image behind them. ignore-error=true stopped that from failing the
# build, and thereby made it SILENT: sandbox:buildcache froze at 2026-07-23 and nothing said so for eight days,
# during which every sandbox build ran fully cold (~20 min, in both the images and release jobs, every
# pipeline). Inline has no second upload to fail — if the image pushed, the cache is fresh.
publish() {
    local image="$1" dockerfile="$2" context="$3"
    shift 3
    local tag_args=()
    for tag in $TAGS; do
        tag_args+=(-t "$REGISTRY/$image:$tag")
    done
    # `latest` moves on every main push that touches the core, `stable` on every release; whichever is newer is
    # a warm parent, and the release job (which pushes neither) reads both. A missing or unreachable ref is a
    # non-fatal warning, so this is correct against a cold registry too.
    docker buildx build -f "$dockerfile" "${tag_args[@]}" \
        --cache-from "type=registry,ref=$REGISTRY/$image:latest" \
        --cache-from "type=registry,ref=$REGISTRY/$image:stable" \
        --cache-to "type=inline" \
        "$@" --push "$context"
}

# The sandbox image COPYs its compiled payload from .image-out — prepare-image-trees.sh must have run first.
[ -d "$root/.image-out/sandbox" ] || { echo "missing $root/.image-out — run _tools/scripts/prepare-image-trees.sh first" >&2; exit 1; }
publish sandbox "$root/_apps/sandbox/Dockerfile" "$root" --build-context "trees=$root/.image-out"
publish dind-host "$root/_tools/dind-host/Dockerfile" "$root/_tools/dind-host"
