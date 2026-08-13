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
#   GITHUB_TOKEN=… bash _tools/scripts/rollback-stable.sh 1.200.0
set -euo pipefail
VERSION="${1:?usage: rollback-stable.sh <version>   (e.g. 1.200.0 — the version to put stable back onto)}"
VERSION="${VERSION#v}"
. "$(dirname "$0")/repo-root.sh"
# Three manifest writes back to back is the shape GHCR throttles — and a rollback refused halfway leaves the
# stable lane pointing at two versions at once. registry-retry.sh says the rest.
. "$(dirname "$0")/registry-retry.sh"
cd "$(repo_root)"

REPO="${GITHUB_REPOSITORY:-intentic/intentic}"
REGISTRY="ghcr.io/intentic"
TAG="v${VERSION}"
: "${GITHUB_TOKEN:?rollback needs GITHUB_TOKEN (contents+packages write)}"

api() {
  curl --fail --silent --show-error \
    --header "Authorization: Bearer ${GITHUB_TOKEN}" \
    --header "Accept: application/vnd.github+json" \
    --header "X-GitHub-Api-Version: 2022-11-28" "$@"
}

# Refuse a version that was never released, rather than half-roll-back onto tags that do not exist: the
# Release is read up front, and its id is what step 1 needs anyway.
release_id="$(api "https://api.github.com/repos/${REPO}/releases/tags/${TAG}" 2>/dev/null |
  node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id' 2>/dev/null || true)"
if [ -z "$release_id" ]; then
  echo "no release ${TAG} in ${REPO} — rollback targets a version this repo published" >&2
  exit 1
fi

current="$(api "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null |
  node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).tag_name ?? ""' 2>/dev/null || true)"
if [ "$TAG" = "$current" ]; then
  echo "stable is already ${TAG} — nothing to roll back"
  exit 0
fi
echo "==> rolling stable back to ${TAG} (from ${current:-none})"

# 1. The flag, FIRST — stop serving the bad version before anything else.
printf '{"make_latest":"true"}' | api --request PATCH --header "Content-Type: application/json" --data-binary @- \
  --output /dev/null "https://api.github.com/repos/${REPO}/releases/${release_id}"

# 2. Images. `imagetools create` copies the version's manifest (list or single) under the stable name without
# pulling a layer — the same digests that version shipped with.
printf '%s' "$GITHUB_TOKEN" | docker login ghcr.io --username "${GITHUB_ACTOR:-rollback}" --password-stdin >/dev/null
registry_retry docker buildx imagetools create -t "${REGISTRY}/sandbox:stable" "${REGISTRY}/sandbox:${VERSION}"
registry_retry docker buildx imagetools create -t "${REGISTRY}/sandbox:core-stable" "${REGISTRY}/sandbox:core-${VERSION}"
registry_retry docker buildx imagetools create -t "${REGISTRY}/dind-host:stable" "${REGISTRY}/dind-host:${VERSION}"

# 3. The git pointer, back onto the released commit.
git fetch --quiet origin "refs/tags/${TAG}:refs/tags/${TAG}" 2>/dev/null || true
git push --quiet --force origin "refs/tags/${TAG}:refs/tags/stable"

echo "==> stable is now ${TAG} — the rolled-back release is still published; mark it a pre-release on GitHub if it should never be offered again"
