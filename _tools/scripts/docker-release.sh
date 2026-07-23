#!/usr/bin/env bash
# Shared per-app image release for the PLATFORM images (registry.gitlab.com/radarsu/intentic/{api,web}).
# Runs from an app dir as its `docker:release` turbo task (turbo.json: dependsOn build), so the app and its
# workspace deps are already built job-side with the warm turbo cache — each Dockerfile is a pure COPY of the
# prepared tree, never an in-container install/compile. The OSS core images (sandbox/dind-host) keep their own
# publish-images.sh: same job-side-build philosophy, but they ride semantic-release with a trees payload and
# registry-cache machinery this flow doesn't need.
#
#   docker-release.sh <image> [--prune]
#
# --prune runs `pnpm deploy --prod ./deploy` first (the api: a flat, symlink-free prod tree the Dockerfile
# COPYs). The web skips it — nginx serves the vite dist, no node_modules at runtime.
#
# Content-addressed skip: TURBO_HASH (set by turbo per task) covers the app's files, its workspace dependency
# hashes, and the pruned lockfile — identical content always maps to the same `turbo-<hash>` tag. When that
# tag already exists in the registry, the requested tags are aliased onto it registry-side (imagetools create)
# and nothing is built or pushed, so a main push that only touched engine libs re-releases the platform for
# the cost of two manifest calls. Outside turbo (no TURBO_HASH) the skip is disabled and every run builds.
set -euo pipefail

APP="${1:?usage: docker-release.sh <image> [--prune]}"
shift
REGISTRY="registry.gitlab.com/radarsu/intentic"
IMAGE="$REGISTRY/$APP"

# `latest` tracks main; CI adds the commit tag. TAGS overrides both for hand runs (space-separated).
TAGS="${TAGS:-latest${CI_COMMIT_SHORT_SHA:+ sha-$CI_COMMIT_SHORT_SHA}}"

if [ -n "${TURBO_HASH:-}" ]; then
    HASH_TAG="turbo-$TURBO_HASH"
    if docker manifest inspect "$IMAGE:$HASH_TAG" >/dev/null 2>&1; then
        alias_args=()
        for tag in $TAGS; do
            alias_args+=(--tag "$IMAGE:$tag")
        done
        echo "content unchanged — aliasing tags onto $IMAGE:$HASH_TAG"
        docker buildx imagetools create "${alias_args[@]}" "$IMAGE:$HASH_TAG"
        exit 0
    fi
fi

if [ "${1:-}" = "--prune" ]; then
    rm -rf ./deploy
    name="$(node -p "require('./package.json').name")"
    pnpm --filter="$name" deploy --prod ./deploy
fi

tag_args=()
for tag in $TAGS ${TURBO_HASH:+turbo-$TURBO_HASH}; do
    tag_args+=(-t "$IMAGE:$tag")
done
# --provenance=false keeps a plain manifest (not an attestation-bearing OCI index) so the hash-tag alias
# above stays a straight retag. The app dir is the context; its Dockerfile.dockerignore trims it.
docker build --provenance=false "${tag_args[@]}" .

for tag in $TAGS ${TURBO_HASH:+turbo-$TURBO_HASH}; do
    docker push "$IMAGE:$tag"
done
