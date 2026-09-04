#!/usr/bin/env bash
# UN-SHIP A RELEASE — move stable back onto an earlier version, in one command.
#
# This is the counterweight to shipping on green. Releases used to sit on a `beta` lane for ~48h before a
# nightly job promoted them, so a bad one could be caught in the gap and simply never pointed at; the gap cost
# every release two days and caught nothing, so it is gone (ship-stable.sh). What replaces it is this: the
# ability to put stable back where it was, deliberately, in the seconds after a bad release is noticed.
#
# It moves the SAME four pointers ship-stable.sh and release-images.sh move, in the reverse of the order they
# were set — the "latest" flag FIRST, because it is the one every download link and every sandbox's update
# check follows, and the point of a rollback is to stop serving the bad version before anything else:
#   1. the GitHub Release's make_latest flag  (releases/latest/download/* and the update check)
#   2. ghcr.io/intentic/sandbox:stable + :core-stable + dind-host:stable  (what `ic sandbox update` pulls)
#   3. the git `stable` tag                   (the browsable stable source pointer)
#
# The bad release is left published — its tag, its notes and its assets stay reachable by version, and a
# sandbox pinned to that exact version keeps working. Rolling back only changes what UNPINNED users are
# served. Mark it a pre-release on GitHub too if it should never be offered again.
#
# The version must be one this repo actually released (its images are looked up by tag and the run fails loudly
# if they are not there). Rolling FORWARD is not this script's job — cut a release.
#   GITHUB_TOKEN=… bash _tools/scripts/release/rollback-stable.sh 1.200.0
set -euo pipefail
VERSION="${1:?usage: rollback-stable.sh <version>   (e.g. 1.200.0 — the version to put stable back onto)}"
VERSION="${VERSION#v}"
. "$(dirname "$0")/../lib/repo-root.sh"
. "$(dirname "$0")/../lib/github.sh"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$(repo_root)"

REPO="${GITHUB_REPOSITORY:-intentic/intentic}"
TAG="v${VERSION}"
: "${GITHUB_TOKEN:?rollback needs GITHUB_TOKEN (contents+packages write)}"
GH_API_TOKEN="$GITHUB_TOKEN"

# Refuse a version that was never released, rather than half-roll-back onto tags that do not exist: the
# Release is read up front, and its id is what step 1 needs anyway.
release_id="$(gh_release_id "$REPO" "$TAG")"
if [ -z "$release_id" ]; then
  echo "no release ${TAG} in ${REPO} — rollback targets a version this repo published" >&2
  exit 1
fi

current="$(gh_latest_tag "$REPO")"
if [ "$TAG" = "$current" ]; then
  echo "stable is already ${TAG} — nothing to roll back"
  exit 0
fi
echo "==> rolling stable back to ${TAG} (from ${current:-none})"

# 1. The flag, FIRST — stop serving the bad version before anything else.
gh_make_latest "$REPO" "$release_id"

# 2. Images. promote-image-tag.sh copies the version's manifest (list or single) under the stable name without
# pulling a layer — the same digests that version shipped with, through the same registry fan-out and the same
# retry the release's own publish uses. Three manifest writes back to back is the shape GHCR throttles, and a
# rollback refused halfway leaves the stable lane pointing at two versions at once; the retry lives in that
# script (registry-retry.sh) rather than here, which is why this file no longer sources it.
printf '%s' "$GITHUB_TOKEN" | docker login ghcr.io --username "${GITHUB_ACTOR:-rollback}" --password-stdin >/dev/null
bash "$DIR/../image/promote-image-tag.sh" sandbox "$VERSION" stable
bash "$DIR/../image/promote-image-tag.sh" sandbox "core-$VERSION" core-stable
bash "$DIR/../image/promote-image-tag.sh" dind-host "$VERSION" stable

# 3. The git pointer, back onto the released commit.
gh_move_stable_tag "$TAG"

echo "==> stable is now ${TAG} — the rolled-back release is still published; mark it a pre-release on GitHub if it should never be offered again"
