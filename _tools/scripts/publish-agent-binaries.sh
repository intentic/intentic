#!/usr/bin/env bash
# Publish a cross-compiled machine agent's binaries (built by build-agent-binaries.sh into <package-dir>/dist-bin)
# to this project's PUBLIC generic Package Registry — the anonymous download channel behind
# `curl https://intentic.dev/sync | sh` and `curl https://intentic.dev/computer | sh`.
# GitLab Releases can't serve them: the project is public but its Repository/Releases features are member-only, so
# release-asset downloads 404 for anonymous users; the Package Registry is the one project feature still public.
# Each binary is published under its exact <version> (immutable — skipped if already there, so a re-run is safe) and
# under a moving `latest`, which the install scripts download. Overwriting `latest` relies on GitLab's default
# "duplicates allowed" for generic packages.
#   bash _tools/scripts/publish-agent-binaries.sh _apps/sync intentic-sync 1.153.0
set -euo pipefail
PKG="${1:?usage: publish-agent-binaries.sh <package-dir> <binary-name> <version>}"
NAME="${2:?usage: publish-agent-binaries.sh <package-dir> <binary-name> <version>}"
VERSION="${3:?usage: publish-agent-binaries.sh <package-dir> <binary-name> <version>}"
cd "$(dirname "$0")/../.."

# CI-only: needs the job token + registry URL. A local `release-prepare.sh` dry-run skips instead of failing.
if [ -z "${CI:-}" ]; then
  echo "  skip     binary registry publish (not in CI)"
  exit 0
fi
: "${CI_JOB_TOKEN:?}" "${CI_API_V4_URL:?}" "${CI_PROJECT_ID:?}"
base="${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/packages/generic/${NAME}"
auth=(--header "JOB-TOKEN: ${CI_JOB_TOKEN}")

# One binary, both of its names. Every byte is uploaded twice — the generic registry has no server-side copy,
# so `latest` is a second upload of the same file — and the registry answers in its own time: the 16 uploads a
# release makes took 3m26s in series (pipeline 2725042409), against 25s to cross-compile all eight binaries.
# They are independent of each other, so they go out at once and the wait below fails the script if ANY did.
publish_one() {
  local f="$1" name
  name="$(basename "$f")"
  # Exact version is immutable: a 1-byte ranged GET probes existence so a re-run doesn't re-upload.
  if curl --fail --silent --output /dev/null --range 0-0 "${auth[@]}" "${base}/${VERSION}/${name}"; then
    echo "  skip     ${NAME}/${VERSION}/${name} (already published)"
  else
    echo "  publish  ${NAME}/${VERSION}/${name}"
    curl --fail --silent --show-error --upload-file "$f" "${auth[@]}" "${base}/${VERSION}/${name}"
  fi
  # Moving pointer: always overwrite so `latest` tracks this release (what the install scripts fetch).
  echo "  publish  ${NAME}/latest/${name}"
  curl --fail --silent --show-error --upload-file "$f" "${auth[@]}" "${base}/latest/${name}"
}

pids=()
for f in "${PKG}"/dist-bin/*; do
  publish_one "$f" &
  pids+=("$!")
done

failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=1
done
[ "$failed" -eq 0 ] || { echo "one or more ${NAME} binaries failed to publish" >&2; exit 1; }
