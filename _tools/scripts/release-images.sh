#!/usr/bin/env bash
# The release's image publish (semantic-release publishCmd, after publish-github.sh): build the amd64 halves
# on this runner, then merge the sandbox's version + stable tags with the arm64 half the release workflow's
# sandbox-arm64 job already pushed — built from the SAME commit with the SAME set-versions stamp, which is
# the whole reason the arm build lives inside the release rather than riding the main-push images job (a
# sha-tagged arm image would predate the version stamp, and the two halves of one manifest must not skew).
#   bash _tools/scripts/release-images.sh <version>
set -euo pipefail
VERSION="${1:?usage: release-images.sh <version>}"
. "$(dirname "$0")/repo-root.sh"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$(repo_root)"

bash "$DIR/prepare-image-trees.sh"
# THE RELEASE MOVES `beta`, NEVER `stable`. Every release lands on the beta lane the moment it publishes; the
# `stable` tags (and the git `stable` tag, and the Release's "latest" flag every download link follows) move
# only when promote-stable.sh decides the release has soaked — nightly, after ~48h on the beta lane. That gap
# is the staged rollout: whoever runs beta (the maintainers, first) is the canary for everyone on stable.
TAGS="$VERSION beta" ARCH_SUFFIX=-amd64 IMAGES=sandbox bash "$DIR/publish-images.sh"
# dind-host stays a single amd64 image (publish-images.sh says why) — plain tags, no merge.
TAGS="$VERSION beta" IMAGES=dind-host bash "$DIR/publish-images.sh"
ARM64_REF="$VERSION-arm64" bash "$DIR/merge-image-manifests.sh" sandbox "$VERSION" beta
# The core profile's halves, published by the same jobs under core- prefixed tags (publish-images.sh TAG_PREFIX).
ARM64_REF="core-$VERSION-arm64" bash "$DIR/merge-image-manifests.sh" sandbox "core-$VERSION" core-beta
