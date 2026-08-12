#!/usr/bin/env bash
# Publish an image's multi-arch manifests: for each requested tag, combine the per-arch halves
# publish-images.sh pushed (`<tag>-amd64` + `<tag>-arm64`) into one manifest list under the plain tag —
# registry-side, two manifest calls per tag, no bytes moved (docker-release.sh's imagetools precedent).
#
#   merge-image-manifests.sh <image> <tag>...
#
# ARM64_REF / AMD64_REF pin a half to ONE fixed tag for every requested tag. The release is why they exist:
# both halves are built by the release workflow's per-arch jobs under the version tag alone (those jobs run
# before "beta"/"stable" are decided), so a moving tag's merge names `<version>-amd64` + `<version>-arm64`
# rather than a `beta-amd64` nothing pushed. Missing halves fail loudly — a silently amd64-only `stable`
# would strand every arm sandbox on its next update.
set -euo pipefail
# The merge runs seconds behind the pushes it stitches, so it sits in the same GHCR rate-limit window they do
# — and it is pure manifest writes, which is exactly what gets refused. registry-retry.sh says the rest.
. "$(dirname "$0")/registry-retry.sh"

IMAGE_NAME="${1:?usage: merge-image-manifests.sh <image> <tag>...}"
shift
[ $# -ge 1 ] || { echo "usage: merge-image-manifests.sh <image> <tag>..." >&2; exit 2; }
# Same registry fan-out as publish-images.sh: every listed registry holds both halves (one build pushed to
# all), so each merges its own.
REGISTRIES="${REGISTRIES:-ghcr.io/intentic}"

for registry in $REGISTRIES; do
    for tag in "$@"; do
        registry_retry docker buildx imagetools create \
            -t "$registry/$IMAGE_NAME:$tag" \
            "$registry/$IMAGE_NAME:${AMD64_REF:-$tag-amd64}" \
            "$registry/$IMAGE_NAME:${ARM64_REF:-$tag-arm64}"
    done
done
