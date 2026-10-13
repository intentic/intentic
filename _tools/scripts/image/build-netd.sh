#!/usr/bin/env bash
# Build the sandbox image's netd (_sandbox/netd) into one file: compiled inside the image's own Debian release by
# build.Dockerfile, so the host needs docker and nothing else, and its glibc never leaks into what the image runs.
#   bash _tools/scripts/image/build-netd.sh [out-dir]   (default .image-out/netd)
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
cd "$(repo_root)"

out="${1:-.image-out/netd}"
# Without a working buildx plugin, `docker buildx build` falls through to docker's own parser and fails with "unknown
# flag: --file" (125), which names nothing. Say what is missing instead.
if ! docker buildx version >/dev/null 2>&1; then
    echo "docker buildx is missing or broken (docker buildx version fails), and netd is built with it." >&2
    echo "In a WSL distro the intentic engine serves, ic engine wsl enable <distro> links it again." >&2
    exit 1
fi
# `relay` (_shared/relay) is the one tree outside netd it compiles from, passed as a named context.
docker buildx build --file _sandbox/netd/build.Dockerfile --build-context relay=_shared/relay \
    --output "type=local,dest=$out" _sandbox/netd
[ -x "$out/intentic-netd" ] || { echo "$out/intentic-netd was not produced" >&2; exit 1; }
echo "netd built at $out/intentic-netd"
