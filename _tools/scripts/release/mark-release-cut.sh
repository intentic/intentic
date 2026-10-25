#!/usr/bin/env bash
# Mark a release only from semantic-release's success hook: it may exit 0 without releasing when main has advanced.
# Existing tags can belong to earlier runs, so they are not proof this run published. Avoid requiring GITHUB_OUTPUT outside CI.
# Marker write failures are fatal: downstream registry publishes and attestations must not silently skip a completed release.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
cd "$(repo_root)"

VERSION="${1:?usage: mark-release-cut.sh <version>}"

# The name is shared with release.yml, which deletes it before semantic-release runs and reads it after.
printf '%s\n' "$VERSION" > .release-cut
echo "  cut      $VERSION"
