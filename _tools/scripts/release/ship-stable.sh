#!/usr/bin/env bash
# THE LAST STEP OF A RELEASE — the moment the version becomes the one everybody gets. semantic-release's
# publishCmd runs it after publish-github.sh (Release + assets) and release-images.sh (the `stable` image
# tags), and it moves the two pointers that are left:
#   1. the git `stable` tag                    (the browsable stable source pointer)
#   2. the GitHub Release's make_latest flag   (releases/latest/download/* — every connect script and site
#                                               download link — and every sandbox's update check)
#
# WHY THIS IS A SEPARATE SCRIPT AND RUNS LAST. The flag is the one pointer the whole world follows, so nothing
# may flip it until everything it implies is already true: the assets are attached (publish-github.sh) and
# `:stable` resolves to this version (release-images.sh). A release flagged latest before its installers
# finished uploading points every connect one-liner at a 404.
#
# There is no soak. This repo used to publish every release to a `beta` lane and let a nightly job promote it
# to stable after ~48h; the delay was paid on every release, including fixes, and caught nothing, because a
# canary lane only helps if somebody watches it. The pipeline is the gate now — green means shipped — and a
# bad release is pulled with rollback-stable.sh rather than waited out.
#
# Skips without a token so a local release dry-run stays runnable; fatal in CI, where a quiet skip would leave
# a fully built release that nobody is served.
#   bash _tools/scripts/release/ship-stable.sh 1.201.0
set -euo pipefail
VERSION="${1:?usage: ship-stable.sh <version>}"
. "$(dirname "$0")/../lib/repo-root.sh"
. "$(dirname "$0")/../lib/github.sh"
cd "$(repo_root)"

REPO="${GITHUB_REPOSITORY:-intentic/intentic}"
TAG="v${VERSION}"
GH_API_TOKEN="${GITHUB_TOKEN:-}"
gh_require_token "without it this release is built but never served"

echo "==> shipping ${TAG} to stable"

# 1. The git pointer.
gh_move_stable_tag "$TAG"

# 2. The flag, last. From this PATCH on, releases/latest/download serves this release's installers and every
# sandbox's next update check offers this version.
gh_make_latest "$REPO" "$(gh_release_id "$REPO" "$TAG")"

echo "==> stable is now ${TAG}"
