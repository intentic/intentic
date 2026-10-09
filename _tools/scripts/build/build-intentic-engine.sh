#!/usr/bin/env bash
# Build the intentic-engine WSL rootfs tarball into _sandbox/ic/dist-bin for release attach.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
cd "$(repo_root)"
OUT="_sandbox/ic/dist-bin"
mkdir -p "$OUT"
bash _sandbox/ic/engine/build.sh "$OUT"
