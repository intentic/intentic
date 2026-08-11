#!/usr/bin/env bash
# Attaches the build-provenance bundle to the GitHub Release as a `.intoto.jsonl` asset.
#
# The attestation ALREADY EXISTS before this runs — actions/attest-build-provenance wrote it to GitHub's
# attestation store, which is what `gh attestation verify` reads. This script copies it to a second place: the
# Release itself. Two reasons, and the second is the one that pays.
#
#   1. It travels with the download. Someone who mirrors the installers gets the provenance in the same
#      directory listing rather than having to know the attestation API exists.
#   2. It is the ONLY form automated supply-chain audits can see. OpenSSF Scorecard's Signed-Releases check
#      looks for a release asset whose name ends in `.intoto.jsonl` and nothing else — not the attestation
#      store, not the OCI referrers the image attestations push to. Without this the project scores zero on a
#      check it already does the expensive half of, which is a bad advertisement for a tool that asks people
#      to run `curl ... | sh`.
#
# Non-fatal by design, unlike publish-github.sh. The real attestation is already published by the time this
# runs; a failure here costs a convenience copy, not the guarantee, and taking a released version red for it
# would mean re-running a publish that has already shipped.
#   bash _tools/scripts/attach-provenance.sh 1.192.0 /tmp/attestation.jsonl
set -euo pipefail
VERSION="${1:?usage: attach-provenance.sh <version> <bundle-path>}"
BUNDLE="${2:?usage: attach-provenance.sh <version> <bundle-path>}"
. "$(dirname "$0")/repo-root.sh"
cd "$(repo_root)"

REPO="${GITHUB_REPOSITORY:-intentic/intentic}"
TAG="v${VERSION}"
NAME="intentic-${TAG}.intoto.jsonl"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "  skip     ${TAG}/${NAME} (no GITHUB_TOKEN)"
  exit 0
fi
if [ ! -s "$BUNDLE" ]; then
  echo "  skip     ${TAG}/${NAME} (no bundle at ${BUNDLE})" >&2
  exit 0
fi

api() {
  curl --fail --silent --show-error \
    --header "Authorization: Bearer ${GITHUB_TOKEN}" \
    --header "Accept: application/vnd.github+json" \
    --header "X-GitHub-Api-Version: 2022-11-28" "$@"
}

release_id="$(api "https://api.github.com/repos/${REPO}/releases/tags/${TAG}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')"

# Same one-shot-per-name rule as publish-github.sh: GitHub 422s a duplicate, so a re-run skips rather than fails.
existing="$(api "https://api.github.com/repos/${REPO}/releases/${release_id}/assets?per_page=100" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).map(a=>a.name).join("\n")')"
if printf '%s\n' "$existing" | grep -qxF "$NAME"; then
  echo "  skip     ${TAG}/${NAME} (already attached)"
  exit 0
fi

echo "  upload   ${TAG}/${NAME}"
api --output /dev/null --header "Content-Type: application/octet-stream" \
  --data-binary "@${BUNDLE}" \
  "https://uploads.github.com/repos/${REPO}/releases/${release_id}/assets?name=${NAME}"
