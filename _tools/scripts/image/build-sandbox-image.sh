#!/usr/bin/env bash
# Build the sandbox image from this checkout: the payload trees (prepare-image-trees.sh, netd included), the composed
# Dockerfile, then the image. `pnpm build:sandbox` (and so the Sandbox page's rebuild) and connect.sh's dev run both
# build through this one script, so a fix to how a checkout builds lands in both.
#   bash _tools/scripts/image/build-sandbox-image.sh [tag]   (default intentic-sandbox:dev)
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
. "$(dirname "$0")/../lib/docker-config.sh"
cd "$(repo_root)"

tag="${1:-intentic-sandbox:dev}"
# Exported here, so build-netd.sh and the image build below read the same config.
docker_config_without_missing_helpers
bash _tools/scripts/image/prepare-image-trees.sh
node _tools/scripts/image/compose-image-dockerfile.mjs standard >.image-out/Dockerfile.standard

# The `tools` stage first, under a tag named by its own id, which the image then names in its `dev.intentic.tools` label:
# ic builds a sandbox's environment overlay FROM it and replays the per-commit stage on top (image-top.mjs), so the
# overlay's layers survive a rebuild that changed only the daemon. The id is known only once it is built, hence two
# builds; the second finds every `tools` step in the cache the first just wrote. No attestations on it: BuildKit's
# provenance differs on every build, and as part of the image's index it gave an unchanged stage a new id each time,
# which the overlay's FROM keys on (measured: every recipe step re-ran over a byte-identical `tools`).
repo="${tag%:*}"
# zstd level 1 for the new layers where the build compresses them before it unpacks them (the containerd image store,
# which docker info names by its snapshotter): measured on rog, 2.2 GB of new layers exported in 49-62 s as gzip and
# 8-27 s as zstd, the same size on disk. ic exports overlays the same way (docker.rs local_image_output).
tools_out=() image_out=(-t "$tag")
if docker info --format '{{json .DriverStatus}}' 2>/dev/null | grep -q 'io.containerd.snapshotter'; then
    tools_out=(--output "type=image,oci-mediatypes=true,compression=zstd,compression-level=1")
    image_out=(--output "type=image,name=$tag,oci-mediatypes=true,compression=zstd,compression-level=1")
fi
tools_iid="$(mktemp)"
trap 'rm -f "$tools_iid"' EXIT
DOCKER_BUILDKIT=1 docker build --build-context trees=.image-out -f .image-out/Dockerfile.standard --target tools \
    --provenance=false --sbom=false "${tools_out[@]}" --iidfile "$tools_iid" .
tools_id="$(cat "$tools_iid")"
tools_tag="$repo:tools-${tools_id#sha256:}"
tools_tag="${tools_tag:0:$((${#repo} + 7 + 12))}"
docker tag "$tools_id" "$tools_tag"
DOCKER_BUILDKIT=1 docker build --build-context trees=.image-out -f .image-out/Dockerfile.standard \
    --label "dev.intentic.tools=$tools_tag" "${image_out[@]}" .

# Earlier `tools` tags of this repository name nothing the new image needs: an environment built on one keeps its layers
# whatever its tag, and every later build reads the label of the image it extends. Untagged, they free what nothing else
# holds.
docker images --format '{{.Repository}}:{{.Tag}}' "$repo" |
    awk -v keep="$tools_tag" -v prefix="$repo:tools-" 'index($0, prefix) == 1 && $0 != keep' |
    while read -r stale; do docker rmi "$stale" >/dev/null 2>&1 || true; done
