#!/usr/bin/env bash
# Promote an already-published image by copying its manifest to destination tags; no rebuild or layer upload.
# Move single-arch dind-host only after the same gates as multi-arch sandbox, so consumers never get an untested pair.
# Usage: promote-image-tag.sh <image> <source-tag> <dest-tag>...; releases and rollbacks share this registry retry path.
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
    tag_args=()
    for tag in "$@"; do
        tag_args+=(-t "$registry/$IMAGE_NAME:$tag")
    done
    registry_retry docker buildx imagetools create \
        "${tag_args[@]}" \
        "$registry/$IMAGE_NAME:$SOURCE_TAG"
done
