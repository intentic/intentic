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
# The connected-computer agent ships for exactly the platforms the capability offers cards for (Windows, Linux).
bash "$DIR/build-agent-binaries.sh" _apps/host intentic-host linux-x64 linux-arm64 windows-x64
# The desktop app: installers rather than a bun binary, but it stages into _apps/desktop/dist-bin all the same,
# so the export below ships it verbatim.
bash "$DIR/build-desktop.sh" "$VERSION"

# …and prove those exact bytes install and run before anything publishes them. build-desktop.sh ends with
# verify-desktop-bundle.sh (tier 1: the bundled scripts are present and byte-identical); this is tier 2, which
# installs the .deb and the AppImage on a bare Debian, starts the app under Xvfb and fires a real xdg-open
# intentic:// at it.
#
# It runs HERE, in prepareCmd, rather than being left to the desktop-verify job, because that job is not a gate
# and cannot become one: it builds its own artifacts on its own rules, and `release` reaches its `needs` the
# moment verify-core goes green. On 2026-08-03 that gap shipped: desktop-verify failed at 12:34:10 with `the setup
# link opened the Sandbox Manager (waited 45s)` and `the original instance died while handling the link`,
# release started at 12:34:12, and forty minutes later the installers with that bug were on the GitHub Release.
# Verifying the release's OWN output is the only version of this check that cannot be outrun — a failure here
# aborts semantic-release before publish-github.sh, so there is no tag, no Release, and no npm publish.
#
# Linux only, and that is the honest limit: running Intentic-setup.exe needs Windows. Until a Windows runner
# exists the NSIS installer is covered by tier 1 as an archive, and the .ps1 setup path only by the argv unit
# tests in commands.rs.
bash "$DIR/verify-desktop-install.sh"

# The public export, and the last step of the release: it attaches everything in the dist-bin dirs above to a
# GitHub Release — the one download surface for the machine agents and the desktop installers — then pushes the
# `v<version>` tag whose arrival is what publishes the npm packages (GitHub Actions, provenance, tokenless —
# .github/workflows/npm-publish.yml in the mirror).
bash "$DIR/publish-github.sh" "$VERSION"
