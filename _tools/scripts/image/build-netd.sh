#!/usr/bin/env bash
# Build the sandbox image's netd (_sandbox/netd) into one file: compiled inside the image's own Debian release by
# build.Dockerfile, so the host needs docker and nothing else, and its glibc never leaks into what the image runs.
#   bash _tools/scripts/image/build-netd.sh [out-dir]   (default .image-out/netd)
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
cd "$(repo_root)"

out="${1:-.image-out/netd}"
# `relay` (_shared/relay) is the one tree outside netd it compiles from, passed as a named context.
docker buildx build --file _sandbox/netd/build.Dockerfile --build-context relay=_shared/relay \
    --output "type=local,dest=$out" _sandbox/netd
[ -x "$out/intentic-netd" ] || { echo "$out/intentic-netd was not produced" >&2; exit 1; }
echo "netd built at $out/intentic-netd"
