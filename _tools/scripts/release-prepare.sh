#!/usr/bin/env bash
# semantic-release prepareCmd: build the release closure, stamp versions, cross-compile the machine agents and
# the desktop installers, then stage them for the release. Two ordering rules keep this fast:
#   1. Build BEFORE stamping. Versions live only in package.json (read at runtime, never compiled into dist),
#      but package.json is a turbo hash input — stamping first invalidates the whole closure and forces the
#      release to rebuild what release:verify just built. Building first replays verify's cache instead.
#   2. Build ONLY the release closure (PUB + sync's binary input), not the whole monorepo — web/api/site are
#      not release artifacts and verify already gated them. The sandbox image builds its own tree in Docker.
#   bash _tools/scripts/release-prepare.sh 1.135.0
set -euo pipefail
VERSION="${1:?usage: release-prepare.sh <version>}"
: "${PLANNED_RELEASE_VERSION:?PLANNED_RELEASE_VERSION is required}"
: "${PREBUILT_WINDOWS_DESKTOP_DIR:?PREBUILT_WINDOWS_DESKTOP_DIR is required}"
if [ "$VERSION" != "$PLANNED_RELEASE_VERSION" ]; then
  echo "error: semantic-release selected $VERSION after Windows verified $PLANNED_RELEASE_VERSION" >&2
  exit 1
fi
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/packages.sh"
cd "$DIR/../.."

# Fail before anything builds if PUB has drifted from the dependency graph — a listed package depending on an
# unlisted one publishes an unresolvable specifier, and finding that out mid-publish is a half-shipped release.
node "$DIR/verify-publish-set.mjs" "${PUB[@]}"

filters=()
for d in "${PUB[@]}"; do
  filters+=("--filter=./$d")
done
pnpm turbo run build "${filters[@]}"

bash "$DIR/set-versions.sh" "$VERSION"
bash "$DIR/build-agent-binaries.sh" _sandbox/sync intentic-sync linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64
# The connected-computer agent ships for exactly the platforms the capability offers cards for (Windows, Linux).
bash "$DIR/build-agent-binaries.sh" _computers/host intentic-host linux-x64 linux-arm64 windows-x64
# The ic host-side CLI ships for every platform a connect/recreate one-liner can land on: the .sh shims cover
# Linux + macOS, the .ps1 shims Windows. All five come off the zig/xwin toolchains baked into the release
# image, with no Apple SDK anywhere in it (build-ic.sh header).
bash "$DIR/build-ic.sh" linux-x64 linux-arm64 windows-x64 darwin-x64 darwin-arm64
# The desktop app: installers rather than a bun binary, but it stages into _editor/desktop-app/dist-bin all the same,
# so the export below ships it verbatim.
bash "$DIR/build-desktop.sh" "$VERSION" --windows-prebuilt "$PREBUILT_WINDOWS_DESKTOP_DIR"

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
# aborts semantic-release before it tags, so there is no tag, no Release, and no npm publish.
#
# The Linux packages run here; the NSIS installer was already installed, launched, deep-linked and uninstalled
# on the Windows runner before this prepare command was allowed to start. build-desktop.sh staged that exact
# tested file rather than cross-building a replacement, then re-ran the archive verification over the complete
# release set.
bash "$DIR/verify-desktop-install.sh"

# This script ENDS HERE, with the artifacts built, verified and unpublished. Nothing below the prepare step
# belongs in it: semantic-release creates and pushes the `v<version>` tag itself the moment prepare returns, so
# a script that also tagged would hand it a tag that already exists — which is exactly what happened, `fatal:
# tag 'v1.2.0' already exists`, on every release that ever cut a version. publish-github.sh moved to publishCmd
# in .releaserc.json, which runs after that tag is on the remote.
