#!/usr/bin/env bash
# Publish this release: one tag, one GitHub Release with the installers attached. Runs from release-prepare.sh
# after the versions are stamped and the binaries are built, and is what makes the public surface move at once —
#
#   • the pushed `v*` tag triggers .github/workflows/npm-publish.yml, which is where the @intentic/* packages
#     are published — with provenance, tokenless, attested to the commit the tag names;
#   • the Release is the download surface for the desktop installers and the machine-agent binaries — the
#     anonymous download channel behind `curl https://intentic.dev/sync | sh` and `.../computer | sh`.
#
# There is ONE repository. An earlier arrangement exported a public subset to a separate mirror repo, and when
# development moved onto that same repo the export published straight over main — the v1.0.0 snapshot took
# .github/workflows and _apps/api with it. The tag below names the commit CI already checked out, so there is
# no second tree to keep in step and nothing to force-push.
#
# CI setup: GITHUB_TOKEN, a masked CI variable holding a fine-grained PAT with Contents: read+write. Locally,
# without it, this SKIPS so a release-prepare.sh dry-run stays runnable — but IN CI a missing token is fatal. It
# has to be: this script's tag is the only trigger for the npm publish, so a quiet skip on a real release ships
# nothing to npm and still reports green, which is how v1.177.0-v1.179.0 were tagged with no packages behind them.
#   bash _tools/scripts/publish-github.sh 1.177.0
set -euo pipefail
VERSION="${1:?usage: publish-github.sh <version>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR/../.."

REPO="${GITHUB_REPOSITORY:-intentic/intentic}"
TAG="v${VERSION}"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  if [ -n "${CI:-}" ]; then
    echo "GITHUB_TOKEN is unset — this tag is the npm release's only trigger, so this is fatal in CI." >&2
    exit 1
  fi
  echo "  skip     GitHub tag + Release (no GITHUB_TOKEN, not CI)"
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

# --- the tag ------------------------------------------------------------------------------------------------
# It names the commit CI checked out. Pushed BEFORE the Release below, because the tag is what npm-publish.yml
# waits on and the Release is only the download surface.
if git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "  skip     ${TAG} already on origin"
else
  git rev-parse --verify --quiet "refs/tags/${TAG}" >/dev/null ||
    git -c user.name="intentic release" -c user.email="releases@intentic.dev" tag -a "$TAG" -m "$notes"
  echo "==> pushing ${TAG} to ${REPO}"
  git push --quiet origin "refs/tags/${TAG}"
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
