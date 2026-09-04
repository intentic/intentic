#!/usr/bin/env bash
# Does the setup the desktop app runs actually GO THROUGH, on a clean Docker host, using the exact script bytes
# the installer ships?
#
#   verify-desktop-setup.sh [<dist-bin dir>]      # default: _editor/desktop-app/dist-bin
#
# The app's whole native capability is spawning `connect.sh` (scripts.rs states why at length). So the setup
# journey splits in two, and this covers the expensive half:
#
#   • WHAT THE APP PASSES — the argv and env assembly, including the sh-positional / ps1-named divergence that
#     silently misbinds. Unit-tested in _editor/desktop-app/src-tauri/src/commands.rs; costs milliseconds; both hosts.
#   • WHAT THE SCRIPT THEN DOES — pull the image, run the container, wire the network, wait on /health. That is
#     this file, and it needs a real Docker daemon, so it runs nightly rather than per-MR.
#
# The script is EXTRACTED FROM THE BUILT ARTIFACT, not read from _site/site/public/scripts/. That is the whole
# point: verify-desktop-bundle.sh proves the bundled bytes match the source, and this proves those same bundled
# bytes bring a sandbox up. Reading the source tree here would test a file no user ever runs.
#
# HERMETIC — no edge, no Google, no platform. connect.sh documents a direct-token path (CONNECT_TOKEN +
# SANDBOX_GRANT + SANDBOX_HOSTNAME instead of a setup code), which is what makes that possible: `/setup/claim`
# only mints a reachability grant when the platform holds a signing key, so a code-claiming run cannot be
# secret-free. The grant here is a dummy naming an unroutable ingress, so the daemon's tunnel dial fails and
# retries harmlessly in the background — the entrypoint does not gate the daemon on it, and the daemon is
# reached on the container's own published port.
#
# What this therefore does NOT cover: the setup-code claim round trip against a real platform. That needs a
# real signed grant and belongs with the other gated nightly suites, which self-skip without their secrets.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
. "$(dirname "$0")/../lib/desktop-artifacts.sh"
. "$(dirname "$0")/../lib/dind-host.sh"

ROOT="$(repo_root)"
SANDBOX_IMAGE="${SANDBOX_E2E_IMAGE:-ghcr.io/intentic/sandbox:stable}"
# An RFC 2606 reserved TLD: resolvable by no one, so anything here that accidentally reaches for the public
# network fails loudly instead of leaking traffic. Same choice, for the same reason, as hermetic.e2e.test.ts.
HOSTNAME_UNDER_TEST="smoke.e2e.test"
CONNECT_TOKEN="desktop-setup-smoke-token"

if [ ! -d "${1:-$ROOT/_editor/desktop-app/dist-bin}" ]; then
    echo "error: no artifact directory at ${1:-$ROOT/_editor/desktop-app/dist-bin} — build first (build-desktop.sh)" >&2
    exit 1
fi
DIST="$(cd "${1:-$ROOT/_editor/desktop-app/dist-bin}" && pwd)"
DEB="$(desktop_artifact "$DIST" deb)"
if [ -z "$DEB" ]; then
    echo "error: no $(desktop_artifact_glob deb) in $DIST — this tier reads the shipped connect.sh out of the installer." >&2
    exit 1
fi

WORK="$(mktemp -d)"
HOST_CONTAINER="intentic-desktop-setup-smoke"
cleanup() {
    docker rm -f "$HOST_CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

# ── the shipped script ────────────────────────────────────────────────────────────────────────────────────────
echo "==> extracting connect.sh from the installer"
dpkg-deb --fsys-tarfile "$DEB" | tar -x -C "$WORK"
SHIPPED="$(find "$WORK" -type f -path '*/scripts/connect.sh' -print -quit)"
if [ -z "$SHIPPED" ]; then
    echo "error: the installer contains no scripts/connect.sh — verify-desktop-bundle.sh explains what that means." >&2
    exit 1
fi
echo "    ${SHIPPED#"$WORK"/}"

# ── a clean Docker host ───────────────────────────────────────────────────────────────────────────────────────
start_dind_host "$HOST_CONTAINER"

# ── run the setup the app would run ───────────────────────────────────────────────────────────────────────────
# NOT /tmp: the dind entrypoint mounts a tmpfs over /tmp from INSIDE the container's mount namespace, and the
# daemon serving `docker cp` writes through the container's rootfs on the host, underneath that mount. The copy
# reports success (and `docker cp` reads it straight back), while every process in the container sees an empty
# /tmp — which is exactly how this failed: `sh: can't open '/tmp/connect.sh': No such file or directory`. Any
# path the entrypoint does not mount over is fine; /root is the home of the user the setup runs as anyway.
SCRIPT_IN_HOST=/root/connect.sh
docker cp "$SHIPPED" "$HOST_CONTAINER:$SCRIPT_IN_HOST"

# connect.sh is a bootstrap shim: the flow lives in the ic CLI, which the shim downloads from the LATEST
# GitHub Release. This tier verifies THIS COMMIT's flow (and before the first release carrying ic there is
# nothing to download at all), so build ic from the same checkout the installer was built from and hand it in
# via IC_BIN — the shim's own local-dev override. build-ic.sh's linux target is musl/static, which is also
# what lets the binary run in the Alpine dind host.
echo "==> building ic from this checkout"
bash "$ROOT/_tools/scripts/build/build-ic.sh" linux-x64
docker cp "$ROOT/_sandbox/ic/dist-bin/ic-linux-amd64" "$HOST_CONTAINER:/root/ic"
in_host chmod +x /root/ic

echo "==> running the shipped connect.sh (image: $SANDBOX_IMAGE)"
# The env the app's setup_script() assembles, minus the setup code: PLATFORM_URL is pointed at the unroutable
# reserved TLD precisely because nothing on this path should call it — a claim attempt fails loudly instead of
# quietly reaching production.
if in_host env \
    CONNECT_TOKEN="$CONNECT_TOKEN" \
    SANDBOX_GRANT="dummy-reachability-grant" \
    INGRESS_URL="https://ingress.e2e.test" \
    SANDBOX_HOSTNAME="$HOSTNAME_UNDER_TEST" \
    SANDBOX_IMAGE="$SANDBOX_IMAGE" \
    PLATFORM_URL="https://platform.e2e.test" \
    WEB_ORIGIN="http://localhost:47145" \
    IC_BIN=/root/ic \
    sh "$SCRIPT_IN_HOST" -y; then
    echo "  ✓ connect.sh completed — its own gate is a 30s wait on the daemon's /health"
else
    echo "  ✗ connect.sh failed" >&2
    echo "--- the log it leaves on the machine ---" >&2
    in_host sh -c 'cat /var/log/intentic/*.log 2>/dev/null || cat ~/.intentic/logs/*.log 2>/dev/null || true' >&2
    exit 1
fi

# ── independent read-back ─────────────────────────────────────────────────────────────────────────────────────
# connect.sh's success already implies a healthy daemon, so these assert the things its exit code does not: that
# the container is named the way every later flow addresses it (recreate/cleanup/the launcher's docker reads all
# key off `intentic-sandbox-<slug>`), and that the daemon identifies itself.
SLUG="${HOSTNAME_UNDER_TEST%%.*}"
CONTAINER="intentic-sandbox-${SLUG}"
failures=0

if [ "$(in_host docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]; then
    echo "  ✓ $CONTAINER is running"
else
    echo "  ✗ no running container named $CONTAINER — the slug rule the app's launcher relies on has changed" >&2
    failures=$((failures + 1))
fi

if health="$(in_host docker exec "$CONTAINER" curl -fsS --max-time 10 localhost:8787/health 2>/dev/null)"; then
    echo "  ✓ the daemon answers /health: $health"
else
    echo "  ✗ the daemon does not answer /health" >&2
    in_host docker logs --tail 50 "$CONTAINER" >&2 2>&1 || true
    failures=$((failures + 1))
fi

echo
if [ "$failures" -gt 0 ]; then
    echo "==> setup did not complete cleanly ($failures problem(s))" >&2
    exit 1
fi
echo "==> the shipped connect.sh brings a sandbox up on a clean Docker host"
