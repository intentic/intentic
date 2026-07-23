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

# Layer caching. A docker-container buildx builder lets us export a full (mode=max) registry cache — the
# default docker driver only does inline (final-stage) cache, which misses this multi-stage build's heavy
# build stage (pnpm install + turbo build + model fetch). The cache lives in the registry, so it survives the
# ephemeral dind daemon and is shared across the images + release jobs and across pipelines. If the container
# builder can't be set up we fall back to the default builder + inline cache so a build NEVER fails over this.
REGISTRY_CACHE=0
setup_builder() {
    command -v docker >/dev/null || return 0
    if docker buildx inspect intentic-cache >/dev/null 2>&1; then
        docker buildx use intentic-cache && REGISTRY_CACHE=1
        return 0
    fi
    # dind serves docker over TLS; the docker-container driver can't read those certs from env vars, only from
    # a named context (that's the "could not create a builder instance with TLS data" error). Build one.
    local ctx=default
    if [ -n "${DOCKER_CERT_PATH:-}" ] && [ -n "${DOCKER_HOST:-}" ]; then
        docker context create intentic-dind \
            --docker "host=${DOCKER_HOST},ca=${DOCKER_CERT_PATH}/ca.pem,cert=${DOCKER_CERT_PATH}/cert.pem,key=${DOCKER_CERT_PATH}/key.pem" >/dev/null 2>&1 || true
        docker context inspect intentic-dind >/dev/null 2>&1 && ctx=intentic-dind
    fi
    if docker buildx create --name intentic-cache --driver docker-container --bootstrap --use "$ctx" >/dev/null 2>&1; then
        REGISTRY_CACHE=1
    else
        echo "  note: docker-container builder unavailable; using default builder + inline cache" >&2
    fi
}
setup_builder

# Build + push one image under every requested tag. The Dockerfile + build context differ per image: the
# sandbox builds from the monorepo root; the dind-host from its self-contained _tools/dind-host package.
# A missing cache ref (first ever build) is a non-fatal warning, so this is safe on a cold registry.
publish() {
    local image="$1" dockerfile="$2" context="$3"
    local tag_args=() cache_args=()
    for tag in $TAGS; do
        tag_args+=(-t "$REGISTRY/$image:$tag")
    done
    if [ "$REGISTRY_CACHE" = 1 ]; then
        cache_args=(--cache-from "type=registry,ref=$REGISTRY/$image:buildcache"
                    --cache-to "type=registry,ref=$REGISTRY/$image:buildcache,mode=max,image-manifest=true")
    else
        cache_args=(--cache-from "$REGISTRY/$image:latest" --cache-to "type=inline")
    fi
    docker buildx build -f "$dockerfile" "${tag_args[@]}" "${cache_args[@]}" --push "$context"
}

publish sandbox "$root/_apps/sandbox/Dockerfile" "$root"
publish dind-host "$root/_tools/dind-host/Dockerfile" "$root/_tools/dind-host"
