#!/usr/bin/env bash
# One-shot local release, run from an authenticated terminal (npm publishing can't run in CI: OIDC
# trusted publishing cannot CREATE new @intentic/* packages, and CI has no interactive npm session).
# Publishes all first-party npm packages + the sandbox/dind-host images at <version>, tags it, moves `stable`.
# Re-runnable: packages already at <version> on npm are skipped.
#
#   1) commit the release-config fixes first (that commit becomes the tag)
#   2) bash scripts/release-local.sh 1.15.1        # prompts npm OTP if your 2FA covers writes
#   3) git push                                     # CI then no-ops (v<version> already exists)
set -euo pipefail

VERSION="${1:?usage: release-local.sh <version>  e.g. 1.15.1}"
cd "$(dirname "$0")/.."

# Publishable packages in dependency order (deps first). sandbox is version-bumped for its image but not npm-published.
PUB=(_tools/constants _apps/sync _libs/graph _libs/resources _libs/engine _libs/need-resolver _libs/providers \
     _libs/extension-api _libs/sandbox-contract _libs/scaffold _libs/state-resolver _apps/cli \
     _libs/workspace-ignore _libs/iq-engine _libs/iq-recall _apps/iq _libs/sdk)
BUMP=("${PUB[@]}" _apps/sandbox)

echo "== preflight =="
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "not on main"; exit 1; }
who=$(npm whoami) || { echo "not logged in to npm — run: npm login"; exit 1; }
echo "npm user: $who    releasing: v$VERSION    packages: ${#PUB[@]}"
read -r -p "Publish ${#PUB[@]} packages + images at v$VERSION to PUBLIC npm? [y/N] " ok
[ "$ok" = "y" ] || { echo "aborted"; exit 1; }

echo "== 1/5 bump to $VERSION =="
for d in "${BUMP[@]}"; do pnpm --dir "$d" version "$VERSION" --no-git-tag-version --no-git-checks --allow-same-version >/dev/null; done

echo "== 2/5 build =="
pnpm turbo run build

echo "== 3/5 publish to npm (skips versions already published) =="
for d in "${PUB[@]}"; do
  name=$(grep -m1 '"name"' "$d/package.json" | sed -E 's/.*"name"[^"]*"([^"]+)".*/\1/')
  if npm view "$name@$VERSION" version >/dev/null 2>&1; then
    echo "  skip  $name@$VERSION (already on npm)"
  else
    echo "  publish  $name@$VERSION"
    pnpm --dir "$d" publish --access public --no-git-checks
  fi
done

echo "== 4/5 build + push images ($VERSION + stable) =="
TAGS="$VERSION stable" bash scripts/publish-images.sh

echo "== 5/5 tag + move stable =="
git rev-parse "v$VERSION" >/dev/null 2>&1 || { git tag "v$VERSION"; git push origin "v$VERSION"; }
git tag -f stable && git push -f origin stable

echo "== revert ephemeral version bumps (source stays at 0.0.0) =="
git checkout -- .

echo "DONE: v$VERSION — npm + images + tags published."
echo "Optional: create the GitLab Release for v$VERSION (changelog + intentic-sync-* assets) separately."
