#!/usr/bin/env bash
# The release's image publish (semantic-release publishCmd, after publish-github.sh): pure MANIFEST work.
# Both sandbox halves and the dind-host image were already built and pushed under version tags by the release
# workflow's per-arch jobs (images-amd64 on the fleet, sandbox-arm64 on GitHub's arm runners) — built from the
# SAME commit with the SAME set-versions stamp, in parallel with the Windows verification. That placement is
# what took ~11 minutes of image building out of this final serialized step; what is left here moves no bytes:
# stitch the sandbox's version + beta tags from the two halves, and point dind-host's beta at its version.
#   bash _tools/scripts/release-images.sh <version>
set -euo pipefail
VERSION="${1:?usage: release-images.sh <version>}"
. "$(dirname "$0")/repo-root.sh"
. "$(dirname "$0")/registry-retry.sh"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$(repo_root)"
REGISTRIES="${REGISTRIES:-ghcr.io/intentic}"

# THE RELEASE MOVES `beta`, NEVER `stable`. Every release lands on the beta lane the moment it publishes; the
# `stable` tags (and the git `stable` tag, and the Release's "latest" flag every download link follows) move
# only when promote-stable.sh decides the release has soaked — nightly, after ~48h on the beta lane. That gap
# is the staged rollout: whoever runs beta (the maintainers, first) is the canary for everyone on stable.
#
# The halves are pinned to the VERSION-arch tags explicitly: the per-arch jobs push only those — so an aborted
# release orphans at most version-tagged halves, and no beta-* tag ever exists half-moved — which means
# `beta`'s merge must not go looking for a `beta-amd64` nothing ever pushes.
AMD64_REF="$VERSION-amd64" ARM64_REF="$VERSION-arm64" bash "$DIR/merge-image-manifests.sh" sandbox "$VERSION" beta
# The core profile's halves, published by the same jobs under core- prefixed tags (publish-images.sh TAG_PREFIX).
AMD64_REF="core-$VERSION-amd64" ARM64_REF="core-$VERSION-arm64" bash "$DIR/merge-image-manifests.sh" sandbox "core-$VERSION" core-beta

# dind-host stays a single amd64 image (publish-images.sh says why) — no halves to merge, so beta is a
# registry-side copy of the version tag the images-amd64 job pushed.
for registry in $REGISTRIES; do
    registry_retry docker buildx imagetools create -t "$registry/dind-host:beta" "$registry/dind-host:$VERSION"
done
