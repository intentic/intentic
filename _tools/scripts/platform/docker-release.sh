#!/usr/bin/env bash
# Release platform images from prepared job-side builds; ingress alone compiles Rust in a BuildKit stage.
# --prune deploys production dependencies into a temporary tree outside the repo; static web assets need no dependency tree.
# TURBO_HASH tags identify content: reuse existing images through registry aliases. Without a hash, always build.
# Sandbox/dind images use publish-images.sh for their release payload and registry-cache flow.
set -euo pipefail
# The platform's two images push several tags in a row into the same registry the sandbox images are filling
# in the same pipeline, so they share its rate-limit window. registry-retry.sh says the rest — it wraps the
# REGISTRY writes below and not the local build, which has nothing to wait out.
. "$(dirname "$0")/../lib/registry-retry.sh"

APP="${1:?usage: docker-release.sh <image> [--prune] [--build-context name=dir ...]}"
shift
PRUNE=""
# A named BuildKit context per sibling tree a Dockerfile compiles from (the ingress's Rust build takes the tunnel crate
# from _sandbox/netd), so a context stays the app's own directory and nothing else of the repository enters it.
context_args=()
while [ $# -gt 0 ]; do
    case "$1" in
        --prune) PRUNE=1 ;;
        --build-context) context_args+=(--build-context "${2:?--build-context takes name=dir}"); shift ;;
        *) echo >&2 "docker-release.sh: unknown argument $1"; exit 2 ;;
    esac
    shift
done
# Space-separated registries, every one of which gets every tag. These images are pulled by the Komodo stack,
# whose compose file names the path it was configured with — so a registry change here has to be matched there.
REGISTRIES="${REGISTRIES:-ghcr.io/intentic}"
# The hash probe below reads the FIRST registry only — one manifest call, and the registries carry identical
# content by construction, because everything here is one build pushed to all of them.
IMAGE="${REGISTRIES%% *}/$APP"

# `latest` tracks main; CI adds the commit tag. TAGS overrides both for hand runs (space-separated).
# GITHUB_SHA is the full 40 chars, cut to 8 so `sha-` tags stay short and stable.
# `${GITHUB_SHA:-}` first: under `set -u` a hand run, which has no GITHUB_SHA, would stop here.
SHORT_SHA="${GITHUB_SHA:-}"
SHORT_SHA="${SHORT_SHA:0:8}"
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

# The context is the prepared tree: the pruned copy when --prune (the whole tree enters the image, so no
# .dockerignore exists to drift), the app dir otherwise (its .dockerignore keeps only the served artifacts).
#
# THE PRUNED COPY NEVER LIVES IN THE CHECKOUT. It used to be ./deploy, gitignored and left behind, and CI runners
# keep their workspace between jobs: the api's next `suites` run discovered the copy's test files, whose imports
# a --prod tree cannot resolve, and verify-platform failed on dozens of missing modules in code nobody had changed.
# A temporary directory under the runner's temp root is out of reach of every test runner, and the trap removes
# it however the script ends.
CONTEXT="."
if [ -n "$PRUNE" ]; then
    PRUNE_ROOT="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/docker-release-$APP.XXXXXX")"
    trap 'rm -rf "$PRUNE_ROOT"' EXIT
    name="$(node -p "require('./package.json').name")"
    # A path that does not exist yet, so `pnpm deploy` never meets a directory it has to judge empty.
    CONTEXT="$PRUNE_ROOT/tree"
    pnpm --filter="$name" deploy --prod "$CONTEXT"
fi

tag_args=()
for registry in $REGISTRIES; do
    for tag in $TAGS ${TURBO_HASH:+turbo-$TURBO_HASH}; do
        tag_args+=(-t "$registry/$APP:$tag")
    done
done
# WHAT THE IMAGE WILL SAY IT IS, and the reason it is the content-addressed tag rather than the commit: this
# value is baked, so if it were $GITHUB_SHA every commit would change image content and the skip above — the
# whole point of which is that identical content is never rebuilt — would never hit again. The turbo hash IS
# the content, so identical content bakes an identical value and the two stay consistent by construction.
#
# Passed only to an image that DECLARES it, because docker warns about a build-arg nothing consumed and a
# warning every platform image prints on every push is how real ones stop being read. Declaring `ARG BUILD_ID`
# is how an app opts in.
BUILD_ID="${HASH_TAG:-${SHORT_SHA:+sha-$SHORT_SHA}}"
build_args=()
if grep -q '^ARG BUILD_ID' Dockerfile; then
    build_args+=(--build-arg "BUILD_ID=${BUILD_ID:-unreleased}")
fi
# --provenance=false keeps a plain manifest (not an attestation-bearing OCI index) so the hash-tag alias
# above stays a straight retag. -f is explicit because the context may be the pruned copy elsewhere on disk, and
# the Dockerfile read is the app's own, resolved from this directory.
docker build --provenance=false -f Dockerfile "${build_args[@]}" "${context_args[@]}" "${tag_args[@]}" "$CONTEXT"

for registry in $REGISTRIES; do
    for tag in $TAGS ${TURBO_HASH:+turbo-$TURBO_HASH}; do
        registry_retry docker push "$registry/$APP:$tag"
    done
done
