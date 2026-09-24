#!/usr/bin/env bash
# Build the sandbox image's front (_sandbox/front) into one file: compiled inside the image's own Debian release by
# build.Dockerfile, so the host needs docker and nothing else, and its glibc never leaks into what the image runs.
#   bash _tools/scripts/image/build-front.sh [out-dir]   (default .image-out/front)
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
cd "$(repo_root)"

out="${1:-.image-out/front}"
docker buildx build --file _sandbox/front/build.Dockerfile --output "type=local,dest=$out" _sandbox/front
[ -x "$out/intentic-front" ] || { echo "$out/intentic-front was not produced" >&2; exit 1; }
echo "front built at $out/intentic-front"
