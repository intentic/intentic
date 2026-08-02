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

names=()
for d in "${PUB[@]}"; do
  names+=("$(grep -m1 '"name"' "$d/package.json" | sed -E 's/.*"name"[^"]*"([^"]+)".*/\1/')")
done

# The "already on npm?" probes run FIRST and all at once — 21 round trips to the registry, ~2.5s each, which
# is 52s of the 2m03s this script took in pipeline 2725042409 and buys nothing to spend in series. The publish
# loop below stays SERIAL on purpose: PUB is in topological order (packages.sh), and a dependent published
# ahead of its dependency references a version npm cannot resolve yet. That window is short, and it is also
# exactly the failure the ordering exists to prevent.
probe_dir="$(mktemp -d)"
trap 'rm -rf "$probe_dir"' EXIT
for i in "${!names[@]}"; do
  ( pnpm view "${names[$i]}@$VERSION" version >/dev/null 2>&1 && touch "$probe_dir/$i" ) &
done
wait

# Versions are stamped by set-versions.sh (in the release's prepareCmd) before this runs; here we only publish.
for i in "${!PUB[@]}"; do
  if [ -e "$probe_dir/$i" ]; then
    echo "  skip     ${names[$i]}@$VERSION (already on npm)"
  else
    echo "  publish  ${names[$i]}@$VERSION"
    pnpm --dir "${PUB[$i]}" publish --access public --no-git-checks
  fi
done
