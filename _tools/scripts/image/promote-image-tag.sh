#!/usr/bin/env bash
# Point one or more tags at an image that is ALREADY PUBLISHED, registry-side — no bytes moved, no rebuild.
#
#   promote-image-tag.sh <image> <source-tag> <dest-tag>...
#
# The single-arch counterpart of merge-image-manifests.sh, and it exists for the same reason that one does: a
# moving tag must not be written until everything it implies is true. A multi-arch image gets there by having
# its halves stitched at the end; a single-arch one has no halves to stitch, so it needs a way to be pushed
# under an immutable tag first and promoted afterwards. `dind-host` is that image (publish-images.sh says why
# it stays amd64-only).
#
# WHAT THIS FIXED. ci.yml's `images` job used to push `dind-host:latest` directly, in the same step that built
# it, while `sandbox:latest` waited for `images-merge` to stitch the amd64 and arm64 halves. So the two moved
# at different times, and the arm64 half — GitHub-hosted, cold caches, a 90-minute budget — is the most likely
# leg in the pipeline to fail. When it did, the registry was left holding a NEW dind-host:latest beside the
# PREVIOUS sandbox:latest: a pair nothing had ever tested together, consumed by name by nightly's e2e and
# desktop-setup tiers, by verify-images-public.mjs, and by the connect-host.ps1 a Windows user runs.
# Promoting here instead puts both images behind the same gate — they move together or neither moves.
#
# `imagetools create` with ONE source copies the manifest (or the manifest list — an arch-suffixed source works
# just as well), so this is also the shape release-images.sh and rollback-stable.sh use to move `stable` onto a
# version. Both call this script for it now, which is what makes the registry fan-out and the throttle retry one
# decision rather than four copies of one.
set -euo pipefail
# Seconds behind the pushes it promotes, so it sits in the same GHCR rate-limit window they do — and it is pure
# manifest writes, which is exactly what gets refused. registry-retry.sh says the rest.
. "$(dirname "$0")/../lib/registry-retry.sh"

IMAGE_NAME="${1:?usage: promote-image-tag.sh <image> <source-tag> <dest-tag>...}"
SOURCE_TAG="${2:?usage: promote-image-tag.sh <image> <source-tag> <dest-tag>...}"
shift 2
[ $# -ge 1 ] || { echo "usage: promote-image-tag.sh <image> <source-tag> <dest-tag>..." >&2; exit 2; }
# Same registry fan-out as publish-images.sh: every listed registry holds the source (one build pushed to all),
# so each promotes its own.
REGISTRIES="${REGISTRIES:-ghcr.io/intentic}"

for registry in $REGISTRIES; do
    for tag in "$@"; do
        registry_retry docker buildx imagetools create \
            -t "$registry/$IMAGE_NAME:$tag" \
            "$registry/$IMAGE_NAME:$SOURCE_TAG"
    done
done
