#!/usr/bin/env bash
# Stamp <version> onto every first-party package (transient, CI-only — never committed; the repo keeps 0.0.0).
# Bumping ALL of them before build+publish is what lets each published package's workspace:* deps resolve to
# the release version at pack time, and lets version-embedding builds see it. Driven by the shared list in
# packages.sh, so nothing is ever missed (that omission is what published acp-bridge at 0.0.0).
#   bash _tools/scripts/set-versions.sh 1.15.1
set -euo pipefail
VERSION="${1:?usage: set-versions.sh <version>}"
. "$(dirname "$0")/repo-root.sh"
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/packages.sh"
cd "$(repo_root)"

for d in "${VERSIONED[@]}"; do
  pnpm --dir "$d" version "$VERSION" --no-git-tag-version --no-git-checks --allow-same-version >/dev/null
done
echo "set ${#VERSIONED[@]} package versions to $VERSION"
