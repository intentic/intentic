#!/usr/bin/env bash
# semantic-release prepareCmd: build the release closure, stamp versions, cross-compile the machine agents and
# the desktop installers, and export the whole public surface to the GitHub mirror. Two ordering rules keep
# this fast:
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
# The desktop app: installers rather than a bun binary, but it stages into _apps/desktop/dist-bin all the same,
# so both publishers below ship it verbatim.
bash "$DIR/build-desktop.sh" "$VERSION"

# The public export, and the last build artifact this release produces on its own: it attaches everything in
# the dist-bin dirs above to a GitHub Release, then pushes the `v<version>` tag whose arrival is what publishes
# the npm packages (GitHub Actions, provenance, tokenless — .github/workflows/npm-publish.yml in the mirror).
bash "$DIR/publish-github.sh" "$VERSION"

# The GitLab generic Package Registry copy of the desktop installers, and it runs AFTER the export on purpose:
# latest.json now points at the GitHub Release assets, and installed apps that still poll the GitLab endpoint
# (the one baked into every build before this change) must never be handed a manifest whose downloads 404.
bash "$DIR/publish-agent-binaries.sh" _apps/desktop intentic-desktop "$VERSION"
