#!/usr/bin/env bash
# The release's image publish (semantic-release publishCmd, after publish-github.sh): pure MANIFEST work.
# Both sandbox halves and the dind-host image were already built and pushed under version tags by the release
# workflow's per-arch jobs (images-amd64 on the fleet, sandbox-arm64 on GitHub's arm runners) — built from the
# SAME commit with the SAME set-versions stamp, in parallel with the Windows verification. That placement is
# what took ~11 minutes of image building out of this final serialized step; what is left here moves no bytes:
# stitch the sandbox's version + stable tags from the two halves, and point dind-host's stable at its version.
#   bash _tools/scripts/release/release-images.sh <version>
set -euo pipefail
VERSION="${1:?usage: release-images.sh <version>}"
. "$(dirname "$0")/../lib/repo-root.sh"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$(repo_root)"
# Nothing here writes to a registry directly any more — both steps below delegate to a script in `image/`, and
# the GHCR throttle retry (lib/registry-retry.sh) lives there with the writes it wraps.

# THE RELEASE MOVES `stable`. There is ONE lane: a release that gets here has passed the whole pipeline —
# Windows install-verified, both arches built from the same stamp — and a pipeline whose success does not mean
# "shipped" is a pipeline nobody can read. This used to publish `beta` and leave `stable` to a nightly promote
# step that waited out a 48h soak; the soak cost every release two days of latency and caught nothing, because
# a canary lane only works if somebody is actually watching it. Un-shipping a bad release is rollback-stable.sh
# now, deliberately, rather than a delay everyone pays on every release.
#
# The halves are pinned to the VERSION-arch tags explicitly: the per-arch jobs push only those — so an aborted
# release orphans at most version-tagged halves, and no stable-* tag ever exists half-moved — which means
# `stable`'s merge must not go looking for a `stable-amd64` nothing ever pushes.
AMD64_REF="$VERSION-amd64" ARM64_REF="$VERSION-arm64" bash "$DIR/../image/merge-image-manifests.sh" sandbox "$VERSION" stable
# The core profile's halves, published by the same jobs under core- prefixed tags (publish-images.sh TAG_PREFIX).
AMD64_REF="core-$VERSION-amd64" ARM64_REF="core-$VERSION-arm64" bash "$DIR/../image/merge-image-manifests.sh" sandbox "core-$VERSION" core-stable

# dind-host stays a single amd64 image (publish-images.sh says why) — no halves to merge, so stable is a
# registry-side copy of the version tag the images-amd64 job pushed. That is exactly promote-image-tag.sh's
# job, registry fan-out and retry included, rather than a fourth place that spells `imagetools create`.
bash "$DIR/../image/promote-image-tag.sh" dind-host "$VERSION" stable
