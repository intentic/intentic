#!/usr/bin/env bash
# Publish the first-party npm packages at <version>, idempotently — versions already on npm are SKIPPED.
# This makes the release safe to re-run: a failed run just re-publishes whatever didn't land yet.
# Auth comes from ~/.npmrc: in CI the release job writes a granular npm token there (NPM_TOKEN); locally
# it's the maintainer's own `pnpm login` session. (npm's tokenless OIDC trusted publishing is unusable
# here — its token exchange rejects this project's self-hosted GitLab runner.)
#   bash _tools/scripts/publish-npm.sh 1.15.1
set -euo pipefail
VERSION="${1:?usage: publish-npm.sh <version>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/packages.sh"
cd "$DIR/../.."

# Versions are stamped by set-versions.sh (in the release's prepareCmd) before this runs; here we only publish.
for d in "${PUB[@]}"; do
  name=$(grep -m1 '"name"' "$d/package.json" | sed -E 's/.*"name"[^"]*"([^"]+)".*/\1/')
  if pnpm view "$name@$VERSION" version >/dev/null 2>&1; then
    echo "  skip     $name@$VERSION (already on npm)"
  else
    echo "  publish  $name@$VERSION"
    pnpm --dir "$d" publish --access public --no-git-checks
  fi
done
