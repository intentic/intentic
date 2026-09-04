#!/usr/bin/env bash
# Publish the first-party npm packages at <version>, idempotently — versions already on npm are SKIPPED.
# This makes the release safe to re-run: a failed run just re-publishes whatever didn't land yet.
#
#   bash _tools/scripts/release/publish-npm.sh 1.15.1                 the release lane, from CI
#   bash _tools/scripts/release/publish-npm.sh 2.0.0 --interactive    the recovery lane, from a maintainer PC
#
# TWO LANES, ONE PUBLISH PATH. Both walk PUB (packages.sh) in the same topological order, ask npm the same
# "is this version already up?" question, pack the same tarball and publish it through the same retry
# (npm-publish-retry.sh). What differs is who is allowed to publish, and what has to be true first:
#
#   the release lane   Runs in GitHub Actions (.github/workflows/npm-publish.yml), at the `v*` tag
#                      semantic-release pushes to this repository once prepare has built and verified the
#                      artifacts — that workflow is dispatched against the tag rather than triggered by it
#                      (dispatch-publish.sh says why), so `GITHUB_REF_NAME` is the tag either way. Auth is
#                      TOKENLESS: npm exchanges the workflow's OIDC id-token for a short-lived credential, so
#                      there is no NPM_TOKEN to rotate, and every tarball carries a provenance attestation
#                      linking it to the commit and workflow run that built it. Each package must have this
#                      repository and this workflow registered as its trusted publisher on npmjs.com — one
#                      that hasn't been fails in the token exchange, which is the correct outcome: a package
#                      nobody can attest is not published. Versions are expected to be STAMPED already
#                      (set-versions.sh, right after checkout) and a mismatch is fatal.
#   --interactive      A guided manual publish from an authenticated developer PC (`pnpm login` as a
#                      maintainer). Use it when the release lane left a release half-published, or to
#                      BOOTSTRAP a package name nobody has ever published — which the release lane cannot do
#                      at all (see the trusted-publisher refusal below). It stamps the versions itself,
#                      builds, and confirms every publish individually. No provenance: the attestation's
#                      builder id is a GitHub-hosted-runner property and the registry rejects one built
#                      anywhere else. Nothing is pushed to git; it prints the tag command for you to run if
#                      you want semantic-release to continue from here.
#
# WHY A FRESH VERSION MATTERS FOR --interactive: an earlier release timeline published these packages all the
# way up to 1.125.1 before the repo's version numbering was reset to ~1.14. Every version in 1.18.0-1.125.1
# therefore already exists on npm for the long-lived packages (graph/engine/cli/sdk/...) with STALE content,
# and both lanes skip what is already up. To publish a clean, internally consistent set of ALL packages, pass
# a version no package has ever published (above 1.125.1, e.g. 2.0.0) — which is what the audit table's
# publish dates are there to let you check.
#
# pnpm packs, npm publishes. pnpm is the only one of the two that rewrites `workspace:*` and `catalog:` specs
# into real versions while building the tarball; npm is the only one that speaks OIDC and --provenance.
# Splitting the step in two is what lets a pnpm workspace publish attested tarballs at all — and it is why
# both lanes can share one publish, rather than the recovery one reaching for `pnpm publish` and quietly
# shipping a different tarball through a different code path than the release it is repairing.
set -euo pipefail

INTERACTIVE=0
VERSION=""
for arg in "$@"; do
  case "$arg" in
    --interactive) INTERACTIVE=1 ;;
    -*) echo "usage: publish-npm.sh <version> [--interactive]" >&2; exit 2 ;;
    *) VERSION="$arg" ;;
  esac
done
[ -n "$VERSION" ] || { echo "usage: publish-npm.sh <version> [--interactive]" >&2; exit 2; }

# PROVENANCE ONLY PUBLISHES FROM A GITHUB-HOSTED RUNNER, and the registry is the one that says so — LAST. npm
# builds the attestation's builder id out of this environment (`https://github.com/actions/runner/
# $RUNNER_ENVIRONMENT`, libnpmpublish/lib/provenance.js), the tarball packs, the bundle is signed and written
# to the public transparency log, and only the PUT comes back 422: `Unsupported GitHub Actions runner
# environment: "self-hosted"`. v1.208.0 spent an install, a build and a signature to learn that, one package
# into 29 — and a rule that only bites per package is a rule that half-publishes a release. So it is read
# here, once, before the first pack. npm-publish.yml runs on ubuntu-24.04 to satisfy it.
if [ "$INTERACTIVE" = 0 ] && [ "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]; then
  echo "publishing with provenance needs a GitHub-hosted runner; this environment is \"${RUNNER_ENVIRONMENT:-unset}\"." >&2
  echo "npm's registry rejects an attestation built anywhere else, so nothing here would land." >&2
  echo "from a maintainer machine, publish with: bash _tools/scripts/release/publish-npm.sh $VERSION --interactive" >&2
  exit 1
fi

. "$(dirname "$0")/../lib/repo-root.sh"
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/../lib/packages.sh"
# Every publish below goes through npm_publish_retry: the transparency log every tarball is signed into
# refuses a request it has already answered, and 1.243.0 died half-published on exactly that.
# npm-publish-retry.sh says the rest.
. "$DIR/../lib/npm-publish-retry.sh"
cd "$(repo_root)"

command -v node >/dev/null || { echo "node not found on PATH." >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm not found on PATH." >&2; exit 1; }

# The recovery lane publishes under a real login, so refuse before doing anything if there is not one — the
# alternative is discovering it after the bump and the build.
if [ "$INTERACTIVE" = 1 ]; then
  WHO="$(pnpm whoami 2>/dev/null || true)"
  [ -n "$WHO" ] || { echo "Not authenticated to the npm registry. Run 'pnpm login' (as an @intentic maintainer) first." >&2; exit 1; }
  echo "npm user:       $WHO"
  echo "target version: $VERSION"
  echo
fi

names=()
for d in "${PUB[@]}"; do
  names+=("$(node -p "require('./$d/package.json').name")")
done

# Versions live in the tag, not in git — every package.json reads 0.0.0 on disk until set-versions.sh stamps
# it, which the publish workflow does right after checkout and before the build (npm-publish.yml). Checked
# rather than assumed: a mismatch means that stamp did not happen, or happened at another version, and the
# tarball would go out under a version nobody asked for. The recovery lane does its own stamping below, so it
# has nothing to check yet.
if [ "$INTERACTIVE" = 0 ]; then
  for d in "${PUB[@]}"; do
    stamped="$(node -p "require('./$d/package.json').version")"
    [ "$stamped" = "$VERSION" ] || { echo "$d is at $stamped, not the released $VERSION" >&2; exit 1; }
  done
fi

# The registry probes run FIRST and all at once — 23 round trips, ~2.5s each, which is a minute of pure
# waiting to spend in series for nothing. The publish loop below stays SERIAL on purpose: PUB is in
# topological order (packages.sh), and a dependent published ahead of its dependency references a version npm
# cannot resolve yet. That window is short, and it is also exactly the failure the ordering exists to prevent.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Publish timestamp of $name@$VERSION on npm, or empty when that version — or the whole package — does not
# exist. The `|| true` is essential: `pnpm view` exits non-zero for a never-published package, and under
# `set -euo pipefail` that would abort the audit mid-loop.
pub_time() {
  { pnpm view "$1" time --json 2>/dev/null || true; } \
    | VER="$VERSION" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s)[process.env.VER]||"")}catch{}})'
}

for i in "${!names[@]}"; do
  if [ "$INTERACTIVE" = 1 ]; then
    # The DATE, not just the fact: what the audit below is for is telling a version this build produced from
    # one left behind by the pre-reset timeline, and only the publish date says which is which.
    ( t="$(pub_time "${names[$i]}")"; [ -n "$t" ] && printf '%s' "$t" > "$work/on-npm-$i" ) &
  else
    ( npm view "${names[$i]}@$VERSION" version >/dev/null 2>&1 && touch "$work/on-npm-$i" ) &
    # Does the package exist AT ALL — see the bootstrap check below.
    ( npm view "${names[$i]}" name >/dev/null 2>&1 && touch "$work/exists-$i" ) &
  fi
done
wait

if [ "$INTERACTIVE" = 0 ]; then
  # A PACKAGE THAT HAS NEVER BEEN PUBLISHED CANNOT BE PUBLISHED BY THIS WORKFLOW, and it fails in a way worth
  # spending ten lines to prevent.
  #
  # Trusted publishing is registered per package, on that package's own settings page on npmjs.com. A name
  # nobody has ever published has no such page, so no trusted publisher can be registered against it, so the
  # OIDC exchange has nothing to exchange for. npm reports that as an auth failure on the `npm publish` line —
  # indistinguishable, at a glance, from a misconfigured publisher on a package that does exist.
  #
  # Left to run, it fails ONE PACKAGE AT A TIME, in the middle of a serial loop that has already published the
  # ones before it. The release ends half-landed, and the next person reads an auth error rather than the fact
  # that the name is simply new. So: say it once, up front, naming all of them, before anything ships.
  #
  # The remedy is this same script under --interactive from an authenticated maintainer machine: it bootstraps
  # the first version under a real login, after which each package has a settings page and its trusted
  # publisher can be registered (Settings -> Trusted publisher -> GitHub Actions, workflow `npm-publish.yml`).
  # From the release after that, the release lane owns them.
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
      echo "  bash _tools/scripts/release/publish-npm.sh $VERSION --interactive"
      echo "then register each one's trusted publisher on npmjs.com (workflow: npm-publish.yml) and re-run the tag."
    } >&2
    exit 1
  fi
else
  echo "== Audit: which of the ${#PUB[@]} packages already have $VERSION on npm =="
  todo=0
  present=0
  for i in "${!PUB[@]}"; do
    if [ -e "$work/on-npm-$i" ]; then
      printf '  present  %-26s published %s\n' "${names[$i]}" "$(cat "$work/on-npm-$i")"
      present=$((present + 1))
    else
      printf '  MISSING  %-26s\n' "${names[$i]}"
      todo=$((todo + 1))
    fi
  done
  echo
  echo "missing: $todo   present(skipped): $present"
  if [ "$todo" -eq 0 ]; then
    echo "Nothing to do — every package already has $VERSION."
    exit 0
  fi
  if [ "$present" -gt 0 ]; then
    echo
    echo "!! WARNING: $present package(s) already have $VERSION on npm and will be SKIPPED."
    echo "!! Their existing $VERSION content stays as-is, so the published set will MIX this build with"
    echo "!! whatever those versions already contain. For a clean, consistent release of ALL packages,"
    echo "!! abort and re-run with a version no package has ever published (above 1.125.1, e.g. 2.0.0)."
  fi
  echo
  read -r -p "Set all ${#PUB[@]} packages to $VERSION, build, then publish the $todo missing? [y/N] " ok
  [ "$ok" = "y" ] || { echo "Aborted."; exit 1; }

  # The same stamp the release lane's workflow applies before it ever reaches this script, done here because
  # nothing else has: every package, even the skipped ones, so cross-package workspace:* deps resolve to
  # $VERSION at pack time.
  echo "== Bumping all packages to $VERSION =="
  bash "$DIR/set-versions.sh" "$VERSION"

  if [ "${SKIP_BUILD:-}" = "1" ]; then
    echo "== SKIP_BUILD=1 — assuming dist/ is already built =="
  else
    echo "== Building (pnpm turbo run build) =="
    pnpm turbo run build
  fi
  echo "== Publishing $VERSION (per-package confirmation) =="
fi

published=0
for i in "${!PUB[@]}"; do
  if [ -e "$work/on-npm-$i" ]; then
    echo "  skip     ${names[$i]}@$VERSION (already on npm)"
    continue
  fi
  if [ "$INTERACTIVE" = 1 ]; then
    read -r -p "  publish ${names[$i]}@$VERSION ? [y/N] " yn
    [ "$yn" = "y" ] || { echo "  skipped  ${names[$i]}"; continue; }
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
  # --provenance only in the release lane: the attestation names a GitHub-hosted runner, and the registry
  # refuses one built anywhere else (the check at the top of this file).
  if [ "$INTERACTIVE" = 1 ]; then
    npm_publish_retry "${names[$i]}" "$VERSION" "$out"/*.tgz --access public
  else
    npm_publish_retry "${names[$i]}" "$VERSION" "$out"/*.tgz --access public --provenance
  fi
  published=$((published + 1))
done

if [ "$INTERACTIVE" = 1 ]; then
  echo
  echo "Published $published package(s) at $VERSION."
  echo "If this is the new release tip, tag it so semantic-release continues from here (won't retry old versions):"
  echo "  git tag v$VERSION && git push origin v$VERSION"
fi
