#!/usr/bin/env bash
# Start the publish workflows that hang off a release, at the tag semantic-release just pushed.
#
# WHY THIS FILE EXISTS AT ALL. npm-publish.yml and vscode-publish.yml used to say `on: push: tags` and read as
# if the tag started them. It never did, not once in 200 releases: semantic-release pushes its tag with the
# built-in GITHUB_TOKEN, and GitHub deliberately starts no workflow from an event that token created — the loop
# guard that stops a workflow from triggering itself forever. The failure was silent in the worst way, because
# a trigger that never fires looks exactly like a pipeline with nothing to do: every release went green, npm
# stopped at 1.176.3 while the tags ran on to 1.206.1, and the VSCode extension was never published anywhere.
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
#   bash _tools/scripts/dispatch-publish.sh 1.206.1
set -euo pipefail
VERSION="${1:?usage: dispatch-publish.sh <version>}"

# No repo-root.sh and no cd, unlike its siblings here: this script reads nothing off disk. Everything it needs
# is the tag name and an API it can reach.
REPO="${GITHUB_REPOSITORY:-intentic/intentic}"
TAG="v${VERSION}"

# Every workflow whose artifacts belong to a release. A new publishing target joins the release by being added
# here and nowhere else.
WORKFLOWS=(npm-publish.yml vscode-publish.yml)

if [ -z "${GITHUB_TOKEN:-}" ]; then
  if [ -n "${CI:-}" ]; then
    echo "GITHUB_TOKEN is unset — it is the only thing that can start the publish workflows, so this is fatal in CI." >&2
    exit 1
  fi
  echo "  skip     publish dispatch (no GITHUB_TOKEN, not CI)"
  exit 0
fi

# `actions: write` is what this needs from the job's permissions block, and it is easy to lose: a job's
# `permissions:` REPLACES the set it inherits, so release.yml names it alongside contents/packages/id-token.
for workflow in "${WORKFLOWS[@]}"; do
  curl --fail --silent --show-error \
    --request POST \
    --header "Authorization: Bearer ${GITHUB_TOKEN}" \
    --header "Accept: application/vnd.github+json" \
    --header "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches" \
    --data "{\"ref\":\"${TAG}\"}"
  echo "  dispatch ${workflow} @ ${TAG}"
done
