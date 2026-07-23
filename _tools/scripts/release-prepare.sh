#!/usr/bin/env bash
# semantic-release prepareCmd: build the release closure, stamp versions, cross-compile the sync binaries,
# publish to npm. Two ordering rules keep this fast:
#   1. Build BEFORE stamping. Versions live only in package.json (read at runtime, never compiled into dist),
#      but package.json is a turbo hash input — stamping first invalidates the whole closure and forces the
#      release to rebuild what release:verify just built. Building first replays verify's cache instead.
#   2. Build ONLY the release closure (PUB + sync's binary input), not the whole monorepo — web/api/site are
#      not release artifacts and verify already gated them. The sandbox image builds its own tree in Docker.
#   bash _tools/scripts/release-prepare.sh 1.135.0
set -euo pipefail
VERSION="${1:?usage: release-prepare.sh <version>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/packages.sh"
cd "$DIR/../.."

filters=()
for d in "${PUB[@]}"; do
  filters+=("--filter=./$d")
done
pnpm turbo run build "${filters[@]}"

bash "$DIR/set-versions.sh" "$VERSION"
bash _apps/sync/scripts/build-binaries.sh
bash "$DIR/publish-npm.sh" "$VERSION"
