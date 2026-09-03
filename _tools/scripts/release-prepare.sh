#!/usr/bin/env bash
# semantic-release prepareCmd: assert that every release artifact this run is about to publish EXISTS and is
# the one that was verified, then assemble the release set (updater manifest, checksums, archive verification).
#
# NOTHING IS BUILT HERE ANY MORE. The artifacts arrive from the release workflow's parallel jobs, every one of
# them built from this same commit with the same set-versions stamp, and every one of them a hard `needs` edge
# of the publish job — so a failure in any of them means this command never runs:
#   windows-build   the NSIS installer (executed on a real Windows machine by windows-verify before publish)
#   linux-build     the Linux bundles (installed + launched on a bare Debian there, before they were uploaded),
#                   plus the cross-compiled machine agent + host CLI (intentic-machine, ic)
#   sandbox-arm64 / images-amd64   the container images, under version tags release-images.sh later stitches
# Building serially here is what this replaces: ~11 minutes of installers + binaries inside the one job that
# holds the release lock, after everything was already verified. Staging the SAME bytes the verifiers approved
# is also the stronger claim — a rebuild, however identical its inputs, is a different file than the one that
# was tested (the reasoning windows-build's candidate established; this extends it to every artifact).
#
# A failure here aborts semantic-release before it tags, so there is no tag, no Release, and no npm publish.
#   bash _tools/scripts/release-prepare.sh 1.135.0
set -euo pipefail
VERSION="${1:?usage: release-prepare.sh <version>}"
. "$(dirname "$0")/repo-root.sh"
: "${PLANNED_RELEASE_VERSION:?PLANNED_RELEASE_VERSION is required}"
: "${PREBUILT_WINDOWS_DESKTOP_DIR:?PREBUILT_WINDOWS_DESKTOP_DIR is required}"
if [ "$VERSION" != "$PLANNED_RELEASE_VERSION" ]; then
  echo "error: semantic-release selected $VERSION after the candidates were built at $PLANNED_RELEASE_VERSION" >&2
  exit 1
fi
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/packages.sh"
cd "$(repo_root)"

# Fail before anything publishes if PUB has drifted from the dependency graph — a listed package depending on
# an unlisted one publishes an unresolvable specifier, and finding that out mid-publish is a half-shipped
# release. (preflight runs the same check per pipeline; this copy is what guards a by-hand release.)
node "$DIR/../checks/publish-set.mjs" "${PUB[@]}"

# The machine agents from linux-build's artifact: present and stamped at THIS version, checked by asking a
# binary rather than trusting a directory listing — an artifact from a stale or differently-versioned run
# would ship agents that report the wrong version forever. The chmod is not cosmetic: Actions artifacts do
# not preserve file modes, so the downloaded binaries arrive non-executable — harmless to the Release (the
# install one-liners chmod what they download), fatal to this probe without it.
for probe in _computers/machine/dist-bin/intentic-machine-linux-amd64 _sandbox/ic/dist-bin/ic-linux-amd64; do
  if [ ! -f "$probe" ]; then
    echo "error: $probe is missing — the linux-build artifact did not arrive" >&2
    exit 1
  fi
  chmod +x "$probe"
done
reported="$(_computers/machine/dist-bin/intentic-machine-linux-amd64 version 2>/dev/null || true)"
if [ "$reported" != "$VERSION" ]; then
  echo "error: the staged intentic-machine reports '${reported}', not ${VERSION} — the linux-build artifact was built at a different version" >&2
  exit 1
fi

# Assemble the desktop release set: validate the staged Linux bundles by exact versioned name, stage the
# Windows candidate the Windows runner approved, write latest.json + SHA256SUMS, and re-run the archive
# verification over the complete set.
bash "$DIR/build-desktop.sh" "$VERSION" --assemble "$PREBUILT_WINDOWS_DESKTOP_DIR"

# This script ENDS HERE, with the artifacts staged, verified and unpublished. Nothing below the prepare step
# belongs in it: semantic-release creates and pushes the `v<version>` tag itself the moment prepare returns, so
# a script that also tagged would hand it a tag that already exists — which is exactly what happened, `fatal:
# tag 'v1.2.0' already exists`, on every release that ever cut a version. publish-github.sh moved to publishCmd
# in .releaserc.json, which runs after that tag is on the remote.
