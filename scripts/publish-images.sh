#!/usr/bin/env bash
# Build + push the first-party intentic images to the repo's GHCR (registry.gitlab.com/radarsu/intentic/*):
#   sandbox    the AI-agent workspace daemon + CLI
#   dind-host  a Docker-in-Docker + sshd deploy-target "host" — connect.ps1 stands one up on Windows so a
#              server-less user can deploy locally (the e2e harness + intentic-local.sh use the same recipe)
# Used by CI — the Images workflow (latest + commit SHA on push to main) and the release (the version + the
# moving `stable` tag, via semantic-release successCmd) — and runnable by hand:
#   docker login registry.gitlab.com && TAGS=0.1.0 pnpm publish:images
# TAGS is a space-separated tag list; every listed tag is pushed. On release the moving `stable` tag is pushed
# onto the new version; _libs/state-resolver/src/lib/images.ts and the connect scripts reference `sandbox:stable`
# (unpinned — always the latest release, no digest to maintain). The GHCR packages must be made public once so
# tenant hosts can pull them unauthenticated.
set -euo pipefail

TAGS="${TAGS:?set TAGS (space-separated, e.g. "0.1.0" or "latest sha-abc1234")}"
REGISTRY="registry.gitlab.com/radarsu/intentic"
# Monorepo root (scripts -> up one). The sandbox image's build context is the whole monorepo so
# `pnpm install --frozen-lockfile` resolves the root lockfile; `pnpm deploy` prunes the final image to core.
root="$(cd "$(dirname "$0")/.." && pwd)"

# Build + push one image under every requested tag. The Dockerfile + build context differ per image: the
# sandbox builds from the monorepo root; the dind-host from its self-contained test/host dir.
publish() {
    local image="$1" dockerfile="$2" context="$3"
    local tag_args=()
    for tag in $TAGS; do
        tag_args+=(-t "$REGISTRY/$image:$tag")
    done
    docker buildx build -f "$dockerfile" "${tag_args[@]}" --push "$context"
}

publish sandbox "$root/_apps/sandbox/Dockerfile" "$root"
publish dind-host "$root/test/host/Dockerfile" "$root/test/host"
