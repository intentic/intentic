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
DOCKER_BUILDKIT=1 docker build --build-context trees=.image-out -f .image-out/Dockerfile.standard -t "$tag" .
