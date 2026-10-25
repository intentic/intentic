#!/usr/bin/env bash
# Copy existing build provenance to the Release as .intoto.jsonl so it accompanies downloads and Signed-Releases audits can find it.
# The authoritative attestation is already in GitHub's store; failure to attach this convenience copy is non-fatal.
set -euo pipefail
VERSION="${1:?usage: attach-provenance.sh <version> <bundle-path>}"
BUNDLE="${2:?usage: attach-provenance.sh <version> <bundle-path>}"
. "$(dirname "$0")/../lib/repo-root.sh"
. "$(dirname "$0")/../lib/github.sh"
cd "$(repo_root)"

REPO="${GITHUB_REPOSITORY:-intentic/intentic}"
TAG="v${VERSION}"
NAME="intentic-${TAG}.intoto.jsonl"
GH_API_TOKEN="${GITHUB_TOKEN:-}"

# Not gh_require_token: this one is non-fatal even in CI (see the header), so it stands down on its own terms.
if [ -z "$GH_API_TOKEN" ]; then
  echo "  skip     ${TAG}/${NAME} (no GITHUB_TOKEN)"
  exit 0
fi
if [ ! -s "$BUNDLE" ]; then
  echo "  skip     ${TAG}/${NAME} (no bundle at ${BUNDLE})" >&2
  exit 0
fi

release_id="$(gh_release_id "$REPO" "$TAG")"

# Same one-shot-per-name rule as publish-github.sh: GitHub 422s a duplicate, so a re-run skips rather than fails.
if gh_asset_names "$REPO" "$release_id" | grep -qxF "$NAME"; then
  echo "  skip     ${TAG}/${NAME} (already attached)"
  exit 0
fi

echo "  upload   ${TAG}/${NAME}"
gh_upload_asset "$REPO" "$release_id" "$BUNDLE" "$NAME"
