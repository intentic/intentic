#!/usr/bin/env bash
# Publish the cross-compiled intentic-sync binaries (built by build-binaries.sh into _apps/sync/dist-bin) to this
# project's PUBLIC generic Package Registry — the anonymous download channel for `curl https://intentic.dev/sync | sh`.
# GitLab Releases can't serve them: the project is public but its Repository/Releases features are member-only, so
# release-asset downloads 404 for anonymous users; the Package Registry is the one project feature still public.
# Each binary is published under its exact <version> (immutable — skipped if already there, so a re-run is safe) and
# under a moving `latest`, which sync.sh / sync.ps1 download. Overwriting `latest` relies on GitLab's default
# "duplicates allowed" for generic packages.
#   bash _apps/sync/scripts/publish-binaries.sh 1.153.0
set -euo pipefail
VERSION="${1:?usage: publish-binaries.sh <version>}"
cd "$(dirname "$0")/../../.."

# CI-only: needs the job token + registry URL. A local `release-prepare.sh` dry-run skips instead of failing.
if [ -z "${CI:-}" ]; then
  echo "  skip     binary registry publish (not in CI)"
  exit 0
fi
: "${CI_JOB_TOKEN:?}" "${CI_API_V4_URL:?}" "${CI_PROJECT_ID:?}"
base="${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/packages/generic/intentic-sync"
auth=(--header "JOB-TOKEN: ${CI_JOB_TOKEN}")

for f in _apps/sync/dist-bin/*; do
  name="$(basename "$f")"
  # Exact version is immutable: a 1-byte ranged GET probes existence so a re-run doesn't re-upload.
  if curl --fail --silent --output /dev/null --range 0-0 "${auth[@]}" "${base}/${VERSION}/${name}"; then
    echo "  skip     intentic-sync/${VERSION}/${name} (already published)"
  else
    echo "  publish  intentic-sync/${VERSION}/${name}"
    curl --fail --silent --show-error --upload-file "$f" "${auth[@]}" "${base}/${VERSION}/${name}"
  fi
  # Moving pointer: always overwrite so `latest` tracks this release (what sync.sh / sync.ps1 fetch).
  echo "  publish  intentic-sync/latest/${name}"
  curl --fail --silent --show-error --upload-file "$f" "${auth[@]}" "${base}/latest/${name}"
done
