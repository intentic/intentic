#!/usr/bin/env bash
# Guided, interactive manual publish of the @intentic/* npm closure at <version>, run from an
# authenticated developer PC ('pnpm login' as a maintainer). Use it when CI's OIDC publish left a
# release half-published, or to bootstrap a fresh version line. Uses pnpm throughout (the closure
# relies on workspace: and catalog: protocols that only pnpm rewrites at pack time).
#
# It is idempotent and safe: versions already on npm are SKIPPED, every publish is confirmed
# individually, and it refuses to run without an authenticated pnpm/npm-registry session. Nothing is pushed to
# git — it only prints the tag command for you to run if you want semantic-release to continue
# from here.
#
#   bash _tools/scripts/publish-catchup.sh 2.0.0
#
# WHY A FRESH VERSION MATTERS: an earlier release timeline published these packages all the way up
# to 1.125.1 before the repo's version numbering was reset to ~1.14. Every version in 1.18.0-1.125.1
# therefore already exists on npm for the long-lived packages (graph/engine/cli/sdk/...) with STALE
# content, and this script (like publish-npm.sh) will skip them. To publish a clean, internally
# consistent set of ALL packages, pass a version ABOVE 1.125.1 (e.g. 2.0.0).
set -euo pipefail

VERSION="${1:?usage: publish-catchup.sh <version>   e.g. 2.0.0 (must be > 1.125.1 for a clean set)}"
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/packages.sh"   # PUB — the shared publish list, so this can't drift from the CI release
cd "$DIR/../.."

command -v pnpm >/dev/null || { echo "pnpm not found on PATH."; exit 1; }
command -v node >/dev/null || { echo "node not found on PATH."; exit 1; }

WHO=$(pnpm whoami 2>/dev/null || true)
[ -n "$WHO" ] || { echo "Not authenticated to the npm registry. Run 'pnpm login' (as an @intentic maintainer) first."; exit 1; }

echo "npm user:       $WHO"
echo "target version: $VERSION"
echo

pkg_name() { node -p "require('./$1/package.json').name"; }

# Publish timestamp of $name@$VERSION on npm, or empty if that version — or the whole package —
# does not exist. The `|| true` is essential: `pnpm view` exits non-zero for a never-published
# package (e.g. @intentic/acp-bridge), and under `set -euo pipefail` that would otherwise abort
# the audit mid-loop before we ever reach the publish prompts.
pub_time() {
  { pnpm view "$1" time --json 2>/dev/null || true; } \
    | VER="$VERSION" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s)[process.env.VER]||"")}catch{}})'
}

echo "== Audit: which of the ${#PUB[@]} packages already have $VERSION on npm =="
TODO=()
PRESENT=0
for d in "${PUB[@]}"; do
  name=$(pkg_name "$d")
  t=$(pub_time "$name")
  if [ -n "$t" ]; then
    printf '  present  %-26s published %s\n' "$name" "$t"
    PRESENT=$((PRESENT + 1))
  else
    printf '  MISSING  %-26s\n' "$name"
    TODO+=("$d")
  fi
done
echo
echo "missing: ${#TODO[@]}   present(skipped): $PRESENT"

if [ ${#TODO[@]} -eq 0 ]; then
  echo "Nothing to do — every package already has $VERSION."
  exit 0
fi

if [ "$PRESENT" -gt 0 ]; then
  echo
  echo "!! WARNING: $PRESENT package(s) already have $VERSION on npm and will be SKIPPED."
  echo "!! Their existing $VERSION content stays as-is, so the published set will MIX this build with"
  echo "!! whatever those versions already contain. For a clean, consistent release of ALL packages,"
  echo "!! abort and re-run with a version no package has ever published (above 1.125.1, e.g. 2.0.0)."
fi

echo
read -r -p "Set all ${#PUB[@]} packages to $VERSION, build, then publish the ${#TODO[@]} missing? [y/N] " ok
[ "$ok" = "y" ] || { echo "Aborted."; exit 1; }

# Bump every package (even skipped ones) so cross-package workspace:* deps resolve to $VERSION at pack time.
echo "== Bumping all packages to $VERSION =="
for d in "${PUB[@]}"; do
  pnpm --dir "$d" version "$VERSION" --no-git-tag-version --no-git-checks --allow-same-version >/dev/null
done

if [ "${SKIP_BUILD:-}" = "1" ]; then
  echo "== SKIP_BUILD=1 — assuming dist/ is already built =="
else
  echo "== Building (pnpm turbo run build) =="
  pnpm turbo run build
fi

echo "== Publishing $VERSION (per-package confirmation) =="
PUBLISHED=()
for d in "${TODO[@]}"; do
  name=$(pkg_name "$d")
  read -r -p "  publish $name@$VERSION ? [y/N] " yn
  if [ "$yn" != "y" ]; then echo "  skipped $name"; continue; fi
  pnpm --dir "$d" publish --access public --no-git-checks
  PUBLISHED+=("$name")
done

echo
echo "Published ${#PUBLISHED[@]} package(s) at $VERSION:"
printf '  %s\n' "${PUBLISHED[@]:-<none>}"
echo
echo "If this is the new release tip, tag it so semantic-release continues from here (won't retry old versions):"
echo "  git tag v$VERSION && git push origin v$VERSION"
