#!/usr/bin/env bash
# Publish the first-party npm packages at <version>, idempotently — versions already on npm are SKIPPED.
# This makes the release safe to re-run: a failed run just re-publishes whatever didn't land yet.
#
# Runs in GitHub Actions (.github/workflows/npm-publish.yml), on the `v*` tag semantic-release pushes to this
# repository once prepare has built and verified the artifacts. Auth is TOKENLESS: npm exchanges the workflow's
# OIDC id-token for a short-lived credential, so there is no NPM_TOKEN to rotate, and every tarball carries a
# provenance attestation linking it to the commit and workflow run that built it. Each package must have this
# repository and this workflow registered as its trusted publisher on npmjs.com — one that hasn't been fails
# here in the token exchange, which is the correct outcome: a package nobody can attest is not published.
#
# pnpm packs, npm publishes. pnpm is the only one of the two that rewrites `workspace:*` and `catalog:` specs
# into real versions while building the tarball; npm is the only one that speaks OIDC and --provenance.
# Splitting the step in two is what lets a pnpm workspace publish attested tarballs at all.
#   bash _tools/scripts/publish-npm.sh 1.15.1
set -euo pipefail
VERSION="${1:?usage: publish-npm.sh <version>}"
. "$(dirname "$0")/repo-root.sh"
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/packages.sh"
cd "$(repo_root)"

# Versions are stamped by set-versions.sh before the tag is pushed, so by the time this runs every
# package.json already carries $VERSION. Checked rather than assumed: a mismatch means the tag and the tree
# disagree, and the tarball would go out under a version nobody asked for.
names=()
for d in "${PUB[@]}"; do
  names+=("$(node -p "require('./$d/package.json').name")")
  stamped="$(node -p "require('./$d/package.json').version")"
  [ "$stamped" = "$VERSION" ] || { echo "$d is at $stamped, not the released $VERSION" >&2; exit 1; }
done

# The "already on npm?" probes run FIRST and all at once — 23 round trips to the registry, ~2.5s each, which
# is a minute of pure waiting to spend in series for nothing. The publish loop below stays SERIAL on purpose:
# PUB is in topological order (packages.sh), and a dependent published ahead of its dependency references a
# version npm cannot resolve yet. That window is short, and it is also exactly the failure the ordering exists
# to prevent.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
for i in "${!names[@]}"; do
  ( npm view "${names[$i]}@$VERSION" version >/dev/null 2>&1 && touch "$work/on-npm-$i" ) &
  # Does the package exist AT ALL — see the bootstrap check below.
  ( npm view "${names[$i]}" name >/dev/null 2>&1 && touch "$work/exists-$i" ) &
done
wait

# A PACKAGE THAT HAS NEVER BEEN PUBLISHED CANNOT BE PUBLISHED BY THIS WORKFLOW, and it fails in a way worth
# spending ten lines to prevent.
#
# Trusted publishing is registered per package, on that package's own settings page on npmjs.com. A name nobody
# has ever published has no such page, so no trusted publisher can be registered against it, so the OIDC
# exchange below has nothing to exchange for. npm reports that as an auth failure on the `npm publish` line —
# indistinguishable, at a glance, from a misconfigured publisher on a package that does exist.
#
# Left to run, it fails ONE PACKAGE AT A TIME, in the middle of a serial loop that has already published the
# ones before it. The release ends half-landed, and the next person reads an auth error rather than the fact
# that the name is simply new. So: say it once, up front, naming all of them, before anything ships.
#
# The remedy is publish-catchup.sh from an authenticated maintainer machine — it bootstraps the first version
# under a real login, after which each package has a settings page and its trusted publisher can be registered
# (Settings -> Trusted publisher -> GitHub Actions, workflow `npm-publish.yml`). From the release after that,
# this script owns them.
missing=()
for i in "${!names[@]}"; do
  [ -e "$work/exists-$i" ] || missing+=("${names[$i]}")
done
if [ "${#missing[@]}" -gt 0 ]; then
  {
    echo "these packages have never been published, so no trusted publisher can exist for them yet:"
    printf '  %s\n' "${missing[@]}"
    echo
    echo "bootstrap them once from an authenticated maintainer machine:"
    echo "  bash _tools/scripts/publish-catchup.sh $VERSION"
    echo "then register each one's trusted publisher on npmjs.com (workflow: npm-publish.yml) and re-run the tag."
  } >&2
  exit 1
fi

for i in "${!PUB[@]}"; do
  if [ -e "$work/on-npm-$i" ]; then
    echo "  skip     ${names[$i]}@$VERSION (already on npm)"
    continue
  fi
  echo "  publish  ${names[$i]}@$VERSION"
  # One tarball per subdir so the glob is unambiguous — npm's scoped-name mangling (@intentic/cli ->
  # intentic-cli-<version>.tgz) is a rule this script has no reason to re-implement.
  out="$work/tgz-$i"
  mkdir -p "$out"
  # MIT asks for the notice in "all copies or substantial portions", and a tarball is a copy — but the license
  # text lives only at the repo root, which no package's `files` reaches. Dropped in beside the package.json
  # for the pack and removed straight after: npm includes a LICENSE unconditionally, so nothing else changes.
  cp LICENSE "${PUB[$i]}/LICENSE"
  pnpm --dir "${PUB[$i]}" pack --pack-destination "$out"
  rm -f "${PUB[$i]}/LICENSE"
  npm publish "$out"/*.tgz --access public --provenance
done
