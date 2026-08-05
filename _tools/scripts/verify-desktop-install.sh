#!/usr/bin/env bash
# Install the built desktop artifacts on a clean machine and prove they run.
#
#   verify-desktop-install.sh [<dist-bin dir>]      # default: _apps/desktop/dist-bin
#
# The tier above verify-desktop-bundle.sh: that one reads the archives, this one actually installs them, starts
# the app on a virtual display and fires a real `intentic://` link at it through xdg-open. See
# _tools/desktop-smoke/smoke.sh for what each run asserts and why.
#
# It needs a Docker daemon and nothing else — no display, no privileges, no secrets. Every artifact present is
# checked; the Windows installer is not among them, because running it needs Windows (the NSIS package's
# contents are covered by verify-desktop-bundle.sh, and its install is the Windows runner's tier).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTEXT="$ROOT/_tools/desktop-smoke"
IMAGE="${DESKTOP_SMOKE_IMAGE:-intentic-desktop-smoke:local}"

if [ ! -d "${1:-$ROOT/_apps/desktop/dist-bin}" ]; then
    echo "error: no artifact directory at ${1:-$ROOT/_apps/desktop/dist-bin} — build first (build-desktop.sh or stage-local-downloads.sh)" >&2
    exit 1
fi
DIST="$(cd "${1:-$ROOT/_apps/desktop/dist-bin}" && pwd)"

echo "==> building the smoke image"
docker build -q -t "$IMAGE" "$CONTEXT" >/dev/null

failures=0
checked=0

smoke() {
    local kind="$1" container="intentic-desktop-smoke-${1}"
    echo
    echo "==> running the ${kind} smoke"
    docker rm -f "$container" >/dev/null 2>&1 || true
    # create + cp + start rather than `run -v "$DIST":/artifacts`: a bind mount is resolved on the DAEMON's
    # filesystem, and in CI the daemon is a separate dind service container that has never seen this job's
    # checkout — the mount would silently be an empty directory. Copying puts the artifacts across the socket,
    # which works against a local and a remote daemon alike.
    #
    # --shm-size: WebKit's web process maps shared memory for its renderer and the 64 MB default is not enough
    # for a real page. Unprivileged otherwise — the sandbox/DMA-BUF accommodations WebKitGTK needs in a
    # container are environment variables inside smoke.sh, not a loosened security profile.
    docker create --name "$container" --shm-size=1g "$IMAGE" "$kind" >/dev/null
    docker cp "$DIST/." "$container:/artifacts"
    checked=$((checked + 1))
    if ! docker start -a "$container"; then
        failures=$((failures + 1))
    fi
    docker rm -f "$container" >/dev/null 2>&1 || true
}

if [ -f "$DIST/Intentic.deb" ]; then smoke deb; fi
if [ -f "$DIST/Intentic.AppImage" ]; then smoke appimage; fi

if [ "$checked" -eq 0 ]; then
    echo "error: no installable artifacts in $DIST (expected Intentic.deb and/or Intentic.AppImage)" >&2
    exit 1
fi

echo
if [ "$failures" -gt 0 ]; then
    echo "==> $failures of $checked artifact(s) failed to install and run" >&2
    exit 1
fi
echo "==> $checked artifact(s) install and run"
