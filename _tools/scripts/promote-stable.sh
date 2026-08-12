#!/usr/bin/env bash
# Promote the newest SOAKED release to the stable lane — the other half of the bargain release-images.sh
# strikes when it publishes every release as `beta` and publish-github.sh creates every Release un-latest.
#
# "Soaked" is time on the beta lane with nothing superseding it: the candidate is the newest release at least
# SOAK_HOURS old, so a release that turned out bad is simply outlived — its fix soaks, the fix promotes, and
# the bad one is never pointed at. A release known bad RIGHT NOW is pulled out of candidacy by marking it a
# pre-release on GitHub (or deleting it), which this script excludes; fast-tracking a fix is running this with
# SOAK_HOURS=0 from a workflow_dispatch of nightly.yml.
#
# One promotion moves FOUR pointers, and the order is deliberate — images first, the "latest" flag last,
# because the flag is the one every download link and every stable sandbox's update check follows, so by the
# time it flips everything it implies is already true:
#   1. ghcr.io/intentic/sandbox:stable + :core-stable + dind-host:stable  (what `ic sandbox update` pulls)
#   2. the git `stable` tag                                               (the browsable stable source pointer)
#   3. the GitHub Release's make_latest flag                              (releases/latest/download/* — every
#      connect script and site download link — and the stable lane's update check, version-check.ts)
#
# Idempotent: when the candidate already IS the latest release this exits saying so, and every step re-run
# lands on the state it left. Runs nightly (.github/workflows/nightly.yml); needs GITHUB_TOKEN with
# contents: write (release flag + tag push) and packages: write (retagging), plus docker with buildx.
#   SOAK_HOURS=48 bash _tools/scripts/promote-stable.sh
set -euo pipefail
. "$(dirname "$0")/repo-root.sh"
# Three manifest writes back to back is the shape GHCR throttles — and a promotion refused halfway leaves the
# stable lane pointing at two versions at once. registry-retry.sh says the rest.
. "$(dirname "$0")/registry-retry.sh"
cd "$(repo_root)"

REPO="${GITHUB_REPOSITORY:-intentic/intentic}"
REGISTRY="ghcr.io/intentic"
SOAK_HOURS="${SOAK_HOURS:-48}"
: "${GITHUB_TOKEN:?promote needs GITHUB_TOKEN (contents+packages write)}"

api() {
  curl --fail --silent --show-error \
    --header "Authorization: Bearer ${GITHUB_TOKEN}" \
    --header "Accept: application/vnd.github+json" \
    --header "X-GitHub-Api-Version: 2022-11-28" "$@"
}

# The newest release old enough to have soaked, and the one currently flagged latest — both read before
# anything moves, so the decision is made from one consistent snapshot.
releases="$(api "https://api.github.com/repos/${REPO}/releases?per_page=30")"
candidate="$(printf '%s' "$releases" | node -pe '
  const releases = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const cutoff = Date.now() - Number(process.env.SOAK_HOURS) * 3600_000;
  const soaked = releases
    .filter((release) => !release.draft && !release.prerelease && Date.parse(release.published_at) <= cutoff)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  soaked[0]?.tag_name ?? "";
')"
if [ -z "$candidate" ]; then
  echo "no release has soaked ${SOAK_HOURS}h yet — nothing to promote"
  exit 0
fi
current="$(api "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).tag_name ?? ""' 2>/dev/null || true)"
if [ "$candidate" = "$current" ]; then
  echo "stable is current (${current})"
  exit 0
fi
# Never promote backwards: after a manual fast-track the nightly's older candidate must not undo it. Dotted
# numeric compare, the same rule isNewer applies in the daemon.
if [ -n "$current" ]; then
  newer="$(node -pe '
    const parse = (tag) => tag.replace(/^v/, "").split(".").map(Number);
    const [a, b] = [parse(process.argv[1]), parse(process.argv[2])];
    let verdict = "false";
    for (let i = 0; i < 3; i++) {
      if ((a[i] ?? 0) > (b[i] ?? 0)) { verdict = "true"; break; }
      if ((a[i] ?? 0) < (b[i] ?? 0)) { break; }
    }
    verdict;
  ' "$candidate" "$current")"
  if [ "$newer" != "true" ]; then
    echo "candidate ${candidate} does not outrank current stable ${current} — leaving it"
    exit 0
  fi
fi
VERSION="${candidate#v}"
echo "==> promoting ${candidate} to stable (current: ${current:-none})"

# 1. Images. `imagetools create` copies the version's manifest (list or single) under the stable name without
# pulling a layer — the same digests the beta lane has been running all along.
printf '%s' "$GITHUB_TOKEN" | docker login ghcr.io --username "${GITHUB_ACTOR:-promote}" --password-stdin >/dev/null
registry_retry docker buildx imagetools create -t "${REGISTRY}/sandbox:stable" "${REGISTRY}/sandbox:${VERSION}"
registry_retry docker buildx imagetools create -t "${REGISTRY}/sandbox:core-stable" "${REGISTRY}/sandbox:core-${VERSION}"
registry_retry docker buildx imagetools create -t "${REGISTRY}/dind-host:stable" "${REGISTRY}/dind-host:${VERSION}"

# 2. The git pointer. The release tag is on the remote (semantic-release pushed it); moving `stable` onto its
# commit needs no local tag object.
git fetch --quiet origin "refs/tags/${candidate}:refs/tags/${candidate}" 2>/dev/null || true
git push --quiet --force origin "refs/tags/${candidate}:refs/tags/stable"

# 3. The flag, last. From this PATCH on, releases/latest/download serves this release's installers and every
# stable sandbox's next hourly check offers this version.
release_id="$(printf '%s' "$releases" | node -pe '
  JSON.parse(require("fs").readFileSync(0, "utf8")).find((release) => release.tag_name === process.argv[1]).id
' "$candidate")"
printf '{"make_latest":"true"}' | api --request PATCH --header "Content-Type: application/json" --data-binary @- \
  --output /dev/null "https://api.github.com/repos/${REPO}/releases/${release_id}"

echo "==> stable now ${candidate}"
