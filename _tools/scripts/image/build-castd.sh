#!/usr/bin/env bash
# Build the sandbox image's castd (_sandbox/castd) into one tree, /opt/castd (castd, its patched Xvfb and libx264):
# compiled inside the image's own Debian release by castd's build.Dockerfile, so the host needs docker and nothing else,
# and its glibc never leaks into what the image runs. The castd pack copies the tree in (image-packs/castd.Dockerfile).
#   bash _tools/scripts/image/build-castd.sh [out-dir]   (default .image-out/castd; the tree lands in <out>/opt/castd)
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
. "$(dirname "$0")/../lib/docker-config.sh"
. "$(dirname "$0")/../lib/buildkit-retry.sh"
cd "$(repo_root)"

out="${1:-.image-out/castd}"
docker_config_without_missing_helpers
if ! docker buildx version >/dev/null 2>&1; then
    echo "docker buildx is missing or broken (docker buildx version fails), and castd is built with it." >&2
    exit 1
fi
# browser-wire (the media protocol's one definition) is the one tree outside castd it compiles from, passed as a named
# context laid out as in the repository.
buildkit_retry docker buildx build --file _sandbox/castd/build.Dockerfile \
    --build-context browser-wire=_sandbox/netd/crates/browser-wire \
    --output "type=local,dest=$out" _sandbox/castd
[ -x "$out/opt/castd/bin/castd" ] || { echo "$out/opt/castd/bin/castd was not produced" >&2; exit 1; }
echo "castd built at $out/opt/castd"
