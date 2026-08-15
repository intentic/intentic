#!/usr/bin/env bash
# Publish the VSCode extension to the Visual Studio Marketplace and Open VSX, from the tag semantic-release
# pushes — invoked by vscode-publish.yml, the same shape as publish-npm.sh / publish-action.sh. That workflow
# is dispatched against the tag rather than triggered by it (dispatch-publish.sh says why).
#
# Inert until the marketplace tokens exist, and LOUDLY so: VSCE_PAT (an Azure DevOps PAT with Marketplace ▸
# Manage scope, for the `intentic` publisher) gates the VS Marketplace push, OVSX_PAT (an open-vsx.org token)
# gates Open VSX. Either missing skips that marketplace without failing the release train — the .vsix files
# are still built, so a run with no tokens is a build check, not a publish.
#
# TARGETS: each .vsix is platform-specific (the engine tree carries natives, and pnpm deploy resolves
# platform-scoped optional deps for the build host). This publishes the targets this runner can assemble and
# prove — linux-x64 today; darwin/win32 join when a runner of that platform exists, and the marketplace
# serves each user the .vsix for their machine.
#   bash _tools/scripts/publish-vscode.sh 1.140.0
set -euo pipefail
VERSION="${1:?usage: publish-vscode.sh <version>}"
. "$(dirname "$0")/repo-root.sh"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$(repo_root)"

EXT=_editor/vscode
TARGETS=(linux-x64)

for target in "${TARGETS[@]}"; do
  bash "$DIR/build-vscode-extension.sh" "$VERSION" "$target"
done

packages=()
for target in "${TARGETS[@]}"; do
  packages+=("$EXT/dist-bin/intentic-$target-$VERSION.vsix")
done

# Both CLIs are pinned devDependencies of the extension package — never dlx, whose build-script approval
# prompt would hang CI.
if [ -n "${VSCE_PAT:-}" ]; then
  for package in "${packages[@]}"; do
    (cd "$EXT" && ./node_modules/.bin/vsce publish --packagePath "$(repo_root)/$package")
  done
  echo "published ${#packages[@]} package(s) to the Visual Studio Marketplace"
else
  echo "VSCE_PAT is not set — skipping the Visual Studio Marketplace publish (the .vsix files are built and staged in $EXT/dist-bin)" >&2
fi

if [ -n "${OVSX_PAT:-}" ]; then
  for package in "${packages[@]}"; do
    (cd "$EXT" && ./node_modules/.bin/ovsx publish "$(repo_root)/$package" -p "$OVSX_PAT")
  done
  echo "published ${#packages[@]} package(s) to Open VSX"
else
  echo "OVSX_PAT is not set — skipping the Open VSX publish" >&2
fi
