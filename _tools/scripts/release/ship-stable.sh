#!/usr/bin/env bash
# Final release step: move the stable git tag and GitHub latest flag only after Release assets and stable images are ready.
# The latest flag controls download links and update checks; moving it before uploads finish serves broken downloads.
# Missing credentials skip local dry runs but fail in CI. Use rollback-stable.sh to withdraw a bad release.
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
