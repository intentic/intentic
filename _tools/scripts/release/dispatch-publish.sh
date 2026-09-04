#!/usr/bin/env bash
# Start the publish workflows that hang off a release, at the tag semantic-release just pushed.
#
# WHY THIS FILE EXISTS AT ALL. npm-publish.yml used to say `on: push: tags` and read as if the tag started it.
# It never did, not once in 200 releases: semantic-release pushes its tag with the built-in GITHUB_TOKEN, and
# GitHub deliberately starts no workflow from an event that token created — the loop guard that stops a
# workflow from triggering itself forever. The failure was silent in the worst way, because a trigger that
# never fires looks exactly like a pipeline with nothing to do: every release went green while npm stopped at
# 1.176.3 and the tags ran on to 1.206.1.
#
# workflow_dispatch is the ONE exception the loop guard makes (with repository_dispatch), so it is the only
# trigger the release job's own token can pull — hence an explicit dispatch rather than an implicit trigger.
#
# THE REF IS THE TAG, not main. Each workflow then checks out the version-stamped tree it is publishing and
# reads its own version off `GITHUB_REF_NAME`, which is what a tag push would have given it — so nothing
# downstream had to change. It also keeps npm's provenance honest: the OIDC claim and the attestation name the
# tagged commit, and a dispatch on main would have signed main's SHA over the tag's contents.
#
# Fatal in CI when the dispatch fails, for the same reason publish-github.sh is: a quiet skip here leaves a
# tagged, released version that reaches no registry and still reports green, which is the exact shape of the
# silence this file was written to end.
#
#   bash _tools/scripts/release/dispatch-publish.sh 1.206.1
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
WORKFLOWS=(npm-publish.yml action-publish.yml webstore-publish.yml)

gh_require_token "it is the only thing that can start the publish workflows"

# THE TAG HAS TO BE THERE, and saying so here is the difference between a diagnosis and a puzzle. A dispatch
# at a ref that does not exist is a 422 with an empty body, which `curl --fail` reports as the bare line
# `curl: (22) The requested URL returned error: 422` — three of the ten most recent red pipelines ended on
# exactly that and nothing else (docs/ci-failure-audit.md, class D). release.yml no longer calls this script
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
