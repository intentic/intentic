#!/usr/bin/env bash
# Dispatch registry publish workflows at semantic-release's tag: tag pushes made with GITHUB_TOKEN do not trigger workflows.
# Use the tag rather than main so checkout, version, OIDC claims and provenance all identify the released commit.
# Dispatch failure is fatal in CI; a successful Release must not silently miss its registry publishes.
set -euo pipefail
VERSION="${1:?usage: dispatch-publish.sh <version>}"

# No repo-root.sh and no cd, unlike its siblings here: this script reads nothing off disk. Everything it needs
# is the tag name and an API it can reach.
. "$(dirname "$0")/../lib/github.sh"
REPO="${GITHUB_REPOSITORY:-intentic/intentic}"
TAG="v${VERSION}"
GH_API_TOKEN="${GITHUB_TOKEN:-}"

# Every workflow whose artifacts belong to a release. A new publishing target joins the release by being added
# here and nowhere else.
#
# action-publish.yml was written after npm-publish.yml was moved off `on: push: tags`, in its shape, and kept
# the trigger it had just been rescued from — so it was a publish workflow nothing could start, and the
# Marketplace action was never published at all. Being in THIS LIST is what makes a publish workflow reachable;
# the workflow-policy check (_tools/checks/) refuses any workflow that tries to reach itself with a tag push instead.
WORKFLOWS=(npm-publish.yml action-publish.yml webstore-publish.yml msstore-publish.yml)

gh_require_token "it is the only thing that can start the publish workflows"

# THE TAG HAS TO BE THERE, and saying so here is the difference between a diagnosis and a puzzle. A dispatch
# at a ref that does not exist is a 422 with an empty body, which `curl --fail` reports as the bare line
# `curl: (22) The requested URL returned error: 422` — three of the ten most recent failed pipelines ended on
# exactly that and nothing else. release.yml no longer calls this script
# when semantic-release declined to release, so reaching here without the tag now means something worse than
# the old race, and it should read that way.
if ! git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null 2>&1 \
  && ! git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "${TAG} does not exist, locally or on origin — semantic-release did not tag this version, so there is" >&2
  echo "nothing for the publish workflows to check out. Not dispatching." >&2
  exit 1
fi

# `actions: write` is what this needs from the job's permissions block, and it is easy to lose: a job's
# `permissions:` REPLACES the set it inherits, so release.yml names it alongside contents/packages/id-token.
for workflow in "${WORKFLOWS[@]}"; do
  if ! gh_api --request POST \
    --header "Content-Type: application/json" \
    --data "{\"ref\":\"${TAG}\"}" \
    "https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches"; then
    echo "dispatching ${workflow} at ${TAG} failed — ${TAG} is released on GitHub but this target is not." >&2
    echo "Start it by hand from the Actions tab at ref ${TAG}, or publish npm from a maintainer PC with" >&2
    echo "  bash _tools/scripts/release/publish-npm.sh ${VERSION} --interactive" >&2
    exit 1
  fi
  echo "  dispatch ${workflow} @ ${TAG}"
done
