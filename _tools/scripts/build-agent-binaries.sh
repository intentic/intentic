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

# THE VERSION THE BINARY WILL REPORT, taken from the package.json set-versions.sh has already stamped — so it is
# the release version by construction, with no second place to bump and forget. A working-tree build reads the
# repo's own 0.0.0 sentinel, which is exactly what an unreleased agent should say it is.
#
# Compiled IN rather than read at runtime because the artifact is a single binary with no package.json beside it.
# The agents guard the identifier with `typeof` (see their version.ts), so a define that never arrives degrades to
# the sentinel instead of a binary that will not start.
version="$(node -p "require('./${pkg}/package.json').version")"

out="${pkg}/dist-bin"
mkdir -p "$out"
for target in "$@"; do
    os="${target%-*}"
    arch="${target#*-}"
    # Asset names use go-style arch (amd64) to match what the install scripts request.
    [ "$arch" = "x64" ] && arch=amd64
    ext=""
    [ "$os" = "windows" ] && ext=".exe"
    bun build --compile --target="bun-${target}" --define "INTENTIC_AGENT_VERSION=\"${version}\"" \
        "${pkg}/dist/cli.js" --outfile "${out}/${name}-${os}-${arch}${ext}"
done

# …and prove the stamp actually landed, by ASKING one of the binaries just built. A define that silently stops
# being applied — a bun flag renamed, an identifier renamed on one side only — produces binaries that build,
# ship, install and run, and report 0.0.0 forever. That failure is invisible at every stage except the one this
# whole signal exists to serve, which is a user being told their agent is current when it is not.
#
# Only the runner's OWN os/arch can be executed here, which is enough: every target comes off the same source
# through the same flag. An agent with no `version` command is not failed for lacking one — it simply is not
# covered yet, and says so rather than passing quietly.
native_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
native_arch="$(uname -m)"
case "$native_arch" in
    x86_64 | amd64) native_arch=amd64 ;;
    arm64 | aarch64) native_arch=arm64 ;;
esac
native="${out}/${name}-${native_os}-${native_arch}"
if [ ! -x "$native" ]; then
    echo "note: ${name} built no ${native_os}-${native_arch} binary — version stamp not verified on this runner." >&2
elif ! reported="$("$native" version 2>/dev/null)"; then
    echo "note: ${name} has no \`version\` command — its stamp is not verified." >&2
elif [ "$reported" != "$version" ]; then
    echo "error: ${name} was stamped ${version} but reports '${reported}' — the --define did not reach the binary." >&2
    exit 1
else
    echo "${name}: version stamp verified (${reported})"
fi
