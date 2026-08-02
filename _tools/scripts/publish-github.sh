#!/usr/bin/env bash
# Export this release to the PUBLIC mirror at github.com/radarsu/intentic: one commit, one tag, one GitHub
# Release with the installers attached. Runs from release-prepare.sh after the versions are stamped and the
# binaries are built, and is what makes the whole public surface move at once —
#
#   • the mirror's tree becomes the source anyone can read (this project's GitLab repository is member-only);
#   • the pushed `v*` tag triggers .github/workflows/npm-publish.yml, which is where the @intentic/* packages
#     are published now — with provenance, tokenless, attested to the commit this script just pushed;
#   • the Release is the download surface for the desktop installers and the machine-agent binaries, which
#     needed the GitLab generic Package Registry precisely because Releases 404 for anonymous users there.
#
# It exports the WORKING TREE, never history: the mirror gets a snapshot per release (public.sh), so nothing
# that was ever committed and removed can surface, and no force-push is ever needed.
#
# CI setup: GITHUB_TOKEN, a masked CI variable holding a fine-grained PAT for radarsu/intentic with Contents:
# read+write. Without it the export SKIPS — a local release-prepare.sh dry-run stays runnable.
#   bash _tools/scripts/publish-github.sh 1.177.0
set -euo pipefail
VERSION="${1:?usage: publish-github.sh <version>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/public.sh"
cd "$DIR/../.."

REPO="${GITHUB_MIRROR_REPO:-radarsu/intentic}"
TAG="v${VERSION}"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "  skip     GitHub mirror (no GITHUB_TOKEN)"
  exit 0
fi

api() {
  curl --fail --silent --show-error \
    --header "Authorization: Bearer ${GITHUB_TOKEN}" \
    --header "Accept: application/vnd.github+json" \
    --header "X-GitHub-Api-Version: 2022-11-28" "$@"
}

# --- release notes ------------------------------------------------------------------------------------------
# Rebuilt from the commit range rather than taken from semantic-release: its notes reach exec plugins only as a
# templated command string, and release notes are exactly the free text that breaks when it is spliced into a
# shell command. The grouping below is the same conventional-commit grouping, computed where the quoting is safe.
prev="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)"
range="${prev:+${prev}..}HEAD"

section() { # <heading> <grep-args...>
  local heading="$1" body
  shift
  body="$(git log --no-merges --pretty=format:'%s' "$range" | grep -E "$@" | sed -E 's/^[a-z]+(\([^)]*\))?!?: *//;s/^/- /' || true)"
  if [ -n "$body" ]; then printf '### %s\n\n%s\n\n' "$heading" "$body"; fi
}

notes="$(
  section Features '^feat(\(|!?:)'
  section Fixes '^fix(\(|!?:)'
  section Other -v '^(feat|fix)(\(|!?:)'
)"

# --- materialise the tree -----------------------------------------------------------------------------------
mirror="$(mktemp -d)"
trap 'rm -rf "$mirror"' EXIT

echo "==> cloning ${REPO}"
# Partial rather than shallow: a blobless clone is just as cheap to fetch but keeps the full commit history, so
# the push below is an ordinary fast-forward with no shallow-push edge cases.
git clone --quiet --filter=blob:none "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" "$mirror"
branch="$(git -C "$mirror" symbolic-ref --short HEAD)"

if git -C "$mirror" rev-parse --verify --quiet "refs/tags/${TAG}" >/dev/null; then
  echo "  skip     ${TAG} already on the mirror"
else
  # Wipe and re-materialise rather than sync: `git add -A` then records the removals too, so a file that left
  # the public set leaves the mirror in the same commit that stopped exporting it.
  find "$mirror" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  materialize_public "$mirror"
  # The exported lockfile is the monorepo's, which still carries the private packages' importers and the root's
  # release-only devDependencies. Reconciling it against the subset is what makes `--frozen-lockfile` work in
  # GitHub Actions; seeding from the full one keeps every resolution that survives identical.
  echo "==> reconciling the subset lockfile"
  (cd "$mirror" && pnpm install --lockfile-only --ignore-scripts)

  git -C "$mirror" add -A
  git -C "$mirror" \
    -c user.name="intentic release" -c user.email="releases@intentic.dev" \
    commit --quiet --allow-empty -m "release: ${TAG}" -m "$notes"
  git -C "$mirror" tag -a "$TAG" -m "$notes"
  echo "==> pushing ${TAG} to ${REPO} (${branch})"
  git -C "$mirror" push --quiet origin "HEAD:${branch}" "refs/tags/${TAG}"
fi

# --- the Release + its assets -------------------------------------------------------------------------------
release_id="$(api "https://api.github.com/repos/${REPO}/releases/tags/${TAG}" 2>/dev/null | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id' 2>/dev/null || true)"
if [ -z "$release_id" ]; then
  echo "==> creating release ${TAG}"
  release_id="$(
    node -pe 'JSON.stringify({tag_name: process.argv[1], name: process.argv[1], body: process.argv[2]})' "$TAG" "$notes" |
      api --header "Content-Type: application/json" --data-binary @- "https://api.github.com/repos/${REPO}/releases" |
      node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id'
  )"
fi

# Uploads are one-shot per name — GitHub 422s a duplicate — so already-attached assets are skipped and a re-run
# only ships what is missing. They go out at once: these are the release's heaviest bytes by far (installers +
# eight cross-compiled binaries) and they are independent of one another.
existing="$(api "https://api.github.com/repos/${REPO}/releases/${release_id}/assets?per_page=100" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).map(a=>a.name).join("\n")')"

upload_one() {
  local f="$1" name
  name="$(basename "$f")"
  if printf '%s\n' "$existing" | grep -qxF "$name"; then
    echo "  skip     ${TAG}/${name} (already attached)"
    return 0
  fi
  echo "  upload   ${TAG}/${name}"
  api --output /dev/null --header "Content-Type: application/octet-stream" \
    --data-binary "@${f}" \
    "https://uploads.github.com/repos/${REPO}/releases/${release_id}/assets?name=${name}"
}

pids=()
for f in _apps/sync/dist-bin/* _apps/host/dist-bin/* _apps/desktop/dist-bin/*; do
  upload_one "$f" &
  pids+=("$!")
done

failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=1
done
[ "$failed" -eq 0 ] || { echo "one or more release assets failed to upload" >&2; exit 1; }

echo "==> https://github.com/${REPO}/releases/tag/${TAG}"
