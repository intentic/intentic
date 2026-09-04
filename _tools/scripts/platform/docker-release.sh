#!/usr/bin/env bash
# Shared per-app image release for the PLATFORM images (ghcr.io/intentic/{api,web}).
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
# The platform's two images push several tags in a row into the same registry the sandbox images are filling
# in the same pipeline, so they share its rate-limit window. registry-retry.sh says the rest — it wraps the
# REGISTRY writes below and not the local build, which has nothing to wait out.
. "$(dirname "$0")/../lib/registry-retry.sh"

APP="${1:?usage: docker-release.sh <image> [--prune]}"
shift
# Space-separated registries, every one of which gets every tag. These images are pulled by the Komodo stack,
# whose compose file names the path it was configured with — so a registry change here has to be matched there.
REGISTRIES="${REGISTRIES:-ghcr.io/intentic}"
# The hash probe below reads the FIRST registry only — one manifest call, and the registries carry identical
# content by construction, because everything here is one build pushed to all of them.
IMAGE="${REGISTRIES%% *}/$APP"

# `latest` tracks main; CI adds the commit tag. TAGS overrides both for hand runs (space-separated).
# GITHUB_SHA is the full 40 chars, cut to 8 so `sha-` tags stay short and stable.
SHORT_SHA="${GITHUB_SHA:0:8}"
TAGS="${TAGS:-latest${SHORT_SHA:+ sha-$SHORT_SHA}}"

if [ -n "${TURBO_HASH:-}" ]; then
    HASH_TAG="turbo-$TURBO_HASH"
    if docker manifest inspect "$IMAGE:$HASH_TAG" >/dev/null 2>&1; then
        alias_args=()
        for registry in $REGISTRIES; do
            for tag in $TAGS; do
                alias_args+=(--tag "$registry/$APP:$tag")
            done
        done
        echo "content unchanged — aliasing tags onto $IMAGE:$HASH_TAG"
        registry_retry docker buildx imagetools create "${alias_args[@]}" "$IMAGE:$HASH_TAG"
        exit 0
    fi
fi

# The context is the prepared tree: the pruned ./deploy when --prune (the whole tree enters the image, so no
# .dockerignore exists to drift), the app dir otherwise (its .dockerignore keeps only the served artifacts).
CONTEXT="."
if [ "${1:-}" = "--prune" ]; then
    rm -rf ./deploy
    name="$(node -p "require('./package.json').name")"
    pnpm --filter="$name" deploy --prod ./deploy
    CONTEXT="./deploy"
fi

tag_args=()
for registry in $REGISTRIES; do
    for tag in $TAGS ${TURBO_HASH:+turbo-$TURBO_HASH}; do
        tag_args+=(-t "$registry/$APP:$tag")
    done
done
# --provenance=false keeps a plain manifest (not an attestation-bearing OCI index) so the hash-tag alias
# above stays a straight retag. -f is explicit because a pruned context carries its own copy of the Dockerfile.
docker build --provenance=false -f Dockerfile "${tag_args[@]}" "$CONTEXT"

for registry in $REGISTRIES; do
    for tag in $TAGS ${TURBO_HASH:+turbo-$TURBO_HASH}; do
        registry_retry docker push "$registry/$APP:$tag"
    done
done
