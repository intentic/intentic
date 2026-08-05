#!/bin/sh
# Cross-compile one of the agents that run on the USER's machine into standalone binaries — the release assets
# the install one-liners download (sync.sh/sync.ps1 for intentic-sync, computer.sh/computer.ps1 for
# intentic-host). Runs after `pnpm turbo run build`; expects <package-dir>/dist/cli.js and `bun` on PATH.
#
#   bash _tools/scripts/build-agent-binaries.sh _sandbox/sync intentic-sync linux-x64 linux-arm64 darwin-x64 …
#
# Targets are explicit per agent rather than a shared list: shipping a binary for a platform no card can hand a
# command for implies support that does not exist (intentic-host is Windows + Linux; sync also covers macOS).
set -eu
cd "$(dirname "$0")/../.."

pkg="${1:?usage: build-agent-binaries.sh <package-dir> <binary-name> <bun-target>...}"
name="${2:?usage: build-agent-binaries.sh <package-dir> <binary-name> <bun-target>...}"
shift 2

out="${pkg}/dist-bin"
mkdir -p "$out"
for target in "$@"; do
    os="${target%-*}"
    arch="${target#*-}"
    # Asset names use go-style arch (amd64) to match what the install scripts request.
    [ "$arch" = "x64" ] && arch=amd64
    ext=""
    [ "$os" = "windows" ] && ext=".exe"
    bun build --compile --target="bun-${target}" "${pkg}/dist/cli.js" --outfile "${out}/${name}-${os}-${arch}${ext}"
done
