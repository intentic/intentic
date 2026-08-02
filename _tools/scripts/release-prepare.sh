#!/usr/bin/env bash
# semantic-release prepareCmd: build the release closure, stamp versions, cross-compile the machine agents,
# publish to npm + the binaries to the public package registry. Two ordering rules keep this fast:
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
bash "$DIR/build-agent-binaries.sh" _apps/sync intentic-sync linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64
bash "$DIR/publish-agent-binaries.sh" _apps/sync intentic-sync "$VERSION"
# The connected-computer agent ships for exactly the platforms the capability offers cards for (Windows, Linux).
bash "$DIR/build-agent-binaries.sh" _apps/host intentic-host linux-x64 linux-arm64 windows-x64
bash "$DIR/publish-agent-binaries.sh" _apps/host intentic-host "$VERSION"
# The desktop app: installers rather than a bun binary, but the same distribution channel — it stages into
# _apps/desktop/dist-bin, so the very same publisher ships it (and for the same reason: this project's
# Releases are member-only, and the generic Package Registry is the one public download surface).
bash "$DIR/build-desktop.sh" "$VERSION"
bash "$DIR/publish-agent-binaries.sh" _apps/desktop intentic-desktop "$VERSION"
bash "$DIR/publish-npm.sh" "$VERSION"
