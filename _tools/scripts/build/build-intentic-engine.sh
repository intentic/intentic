#!/usr/bin/env bash
# Build the intentic-engine WSL rootfs tarball into _hosts/ic/dist-bin for release attach.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
cd "$(repo_root)"
OUT="_hosts/ic/dist-bin"
mkdir -p "$OUT"
bash _hosts/ic/engine/build.sh "$OUT"
