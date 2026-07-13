#!/usr/bin/env bash
# Publish the first-party npm packages at <version>, idempotently — versions already on npm are SKIPPED.
# This makes the release safe to re-run, and safe when packages were published from a developer's
# authenticated PC (npm can't create packages from CI without a per-package trusted publisher). In that
# case CI simply skips them here and continues to images + tag + GitLab release.
#   bash scripts/publish-npm.sh 1.15.1
set -euo pipefail
VERSION="${1:?usage: publish-npm.sh <version>}"
cd "$(dirname "$0")/.."

# Full public dependency-closure, in topological order (deps first).
PUB=(_tools/constants _apps/sync _libs/graph _libs/resources _libs/engine _libs/need-resolver _libs/providers \
     _libs/extension-api _libs/sandbox-contract _libs/scaffold _libs/state-resolver _apps/cli \
     _libs/workspace-ignore _libs/iq-engine _libs/iq-recall _apps/iq _libs/sdk)

for d in "${PUB[@]}"; do
  name=$(grep -m1 '"name"' "$d/package.json" | sed -E 's/.*"name"[^"]*"([^"]+)".*/\1/')
  if npm view "$name@$VERSION" version >/dev/null 2>&1; then
    echo "  skip     $name@$VERSION (already on npm)"
  else
    echo "  publish  $name@$VERSION"
    pnpm --dir "$d" publish --access public --no-git-checks
  fi
done
