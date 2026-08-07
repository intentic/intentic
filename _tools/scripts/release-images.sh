#!/usr/bin/env bash
# The release's image publish (semantic-release publishCmd, after publish-github.sh): build the amd64 halves
# on this runner, then merge the sandbox's version + stable tags with the arm64 half the release workflow's
# sandbox-arm64 job already pushed — built from the SAME commit with the SAME set-versions stamp, which is
# the whole reason the arm build lives inside the release rather than riding the main-push images job (a
# sha-tagged arm image would predate the version stamp, and the two halves of one manifest must not skew).
#   bash _tools/scripts/release-images.sh <version>
set -euo pipefail
VERSION="${1:?usage: release-images.sh <version>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR/../.."

bash "$DIR/prepare-image-trees.sh"
TAGS="$VERSION stable" ARCH_SUFFIX=-amd64 IMAGES=sandbox bash "$DIR/publish-images.sh"
# dind-host stays a single amd64 image (publish-images.sh says why) — plain tags, no merge.
TAGS="$VERSION stable" IMAGES=dind-host bash "$DIR/publish-images.sh"
ARM64_REF="$VERSION-arm64" bash "$DIR/merge-image-manifests.sh" sandbox "$VERSION" stable
