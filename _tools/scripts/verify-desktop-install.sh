#!/usr/bin/env bash
# Install the built desktop artifacts on a clean machine and prove they run.
#
#   verify-desktop-install.sh [<dist-bin dir>]      # default: _editor/desktop-app/dist-bin
#
# The tier above verify-desktop-bundle.sh: that one reads the archives, this one actually installs them, starts
# the app on a virtual display and fires a real `intentic://` link at it through xdg-open. See
# _tools/desktop-smoke/smoke.sh for what each run asserts and why.
#
# It needs a Docker daemon and nothing else — no display, no privileges, no secrets. Every artifact present is
# checked; the Windows installer is not among them, because running it needs Windows (the NSIS package's
# contents are covered by verify-desktop-bundle.sh, and its install by @intentic/desktop-smoke-windows on the
# Windows runner).
set -euo pipefail
. "$(dirname "$0")/repo-root.sh"
. "$(dirname "$0")/desktop-artifacts.sh"

ROOT="$(repo_root)"
CONTEXT="$ROOT/_tools/desktop-smoke"
IMAGE="${DESKTOP_SMOKE_IMAGE:-intentic-desktop-smoke:local}"

if [ ! -d "${1:-$ROOT/_editor/desktop-app/dist-bin}" ]; then
    echo "error: no artifact directory at ${1:-$ROOT/_editor/desktop-app/dist-bin} — build first (build-desktop.sh or stage-local-downloads.sh)" >&2
    exit 1
fi
DIST="$(cd "${1:-$ROOT/_editor/desktop-app/dist-bin}" && pwd)"

echo "==> building the smoke image"
docker build -q -t "$IMAGE" "$CONTEXT" >/dev/null

failures=0
checked=0

# Container names are global to the DAEMON, and every job on the runner host shares one. A name fixed at the
# kind is therefore a name two concurrent jobs both claim, and the second one's `docker rm -f` force-removes the
# first one's RUNNING container — a spurious failure, and inside release-prepare.sh a spurious aborted release.
#
# The suffix is read from /dev/urandom rather than being $$: each job runs in its own container, so PIDs come
# from separate namespaces and two jobs are perfectly capable of both being PID 42 — a suffix that looks unique
# and collides exactly when it matters.
#
# A unique name has no next run reusing it to sweep up after a cancelled one, which is what the trap is for.
containers=()
RUN_TAG="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
cleanup() {
    [ "${#containers[@]}" -eq 0 ] && return 0
    for c in "${containers[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

smoke() {
    local kind="$1" container="intentic-desktop-smoke-${1}-${RUN_TAG}"
    containers+=("$container")
    echo
    echo "==> running the ${kind} smoke"
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
    # The naming rules travel WITH the artifacts, rather than being restated inside the image: smoke.sh has to
    # find a file whose version it does not know, and the image's build context is its own directory, so it
    # cannot reach _tools/scripts at build time. Copied here instead, where both are already in hand.
    docker cp "$ROOT/_tools/scripts/desktop-artifacts.sh" "$container:/usr/local/lib/desktop-artifacts.sh"
    checked=$((checked + 1))
    if ! docker start -a "$container"; then
        failures=$((failures + 1))
    fi
}

# By kind, not by name — the whole directory is copied into the container either way, and smoke.sh finds the
# one it was asked for the same way. What is decided here is only whether there is anything to run.
if [ -n "$(desktop_artifact "$DIST" deb)" ]; then smoke deb; fi
if [ -n "$(desktop_artifact "$DIST" appimage)" ]; then smoke appimage; fi

if [ "$checked" -eq 0 ]; then
    echo "error: no installable artifacts in $DIST (expected $(desktop_artifact_glob deb) and/or $(desktop_artifact_glob appimage))" >&2
    exit 1
fi

echo
if [ "$failures" -gt 0 ]; then
    echo "==> $failures of $checked artifact(s) failed to install and run" >&2
    exit 1
fi
echo "==> $checked artifact(s) install and run"
