#!/usr/bin/env bash
# One GitHub Release, with the installers and the machine-agent binaries attached: the download surface behind
# `curl https://intentic.dev/sync | sh` and `.../computer | sh`. semantic-release's publishCmd, so the `v*` tag
# it hangs off is already on the remote — pushed by semantic-release itself the moment prepare returned, which
# is also what triggers .github/workflows/npm-publish.yml (provenance, tokenless, attested to the tagged commit).
#
# There is ONE repository. An earlier arrangement exported a public subset to a separate mirror repo, and when
# development moved onto that same repo the export published straight over main — the v1.0.0 snapshot took
# .github/workflows and _platform/api with it. The tag names the commit CI already checked out, so there is no
# second tree to keep in step and nothing to force-push.
#
# CI setup: GITHUB_TOKEN, a masked CI variable holding a fine-grained PAT with Contents: read+write. Locally,
# without it, this SKIPS so a release dry-run stays runnable — but IN CI a missing token is fatal. It has to be:
# a quiet skip on a real release leaves a tagged version whose installers nobody can download and still reports
# green, which is the shape of how v1.177.0-v1.179.0 were tagged with no packages behind them.
#   bash _tools/scripts/publish-github.sh 1.177.0
set -euo pipefail
VERSION="${1:?usage: publish-github.sh <version>}"
. "$(dirname "$0")/repo-root.sh"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$(repo_root)"

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
#
# `--exclude "$TAG"` is load-bearing now that this runs in publishCmd: THIS release's tag is already on HEAD by
# the time we get here, so an unfiltered `git describe` answers with it and the range collapses to nothing —
# a Release with empty notes. What is wanted is the release before this one.
prev="$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude "$TAG" 2>/dev/null || true)"
range="${prev:+${prev}..}HEAD"

section() { # <heading> <grep-args...>
  local heading="$1" body
  shift
  body="$(git log --no-merges --pretty=format:'%s' "$range" | grep -E "$@" | sed -E 's/^[a-z]+(\([^)]*\))?!?: *//;s/^/- /' || true)"
  if [ -n "$body" ]; then printf '### %s\n\n%s\n\n' "$heading" "$body"; fi
}

# WHAT A USER WOULD NOTICE, ahead of everything else and in their words — the `Release-Note:` trailers the commit
# drafter writes for a repo that keeps a changelog (see _sandbox/sandbox/src/git/commit-message.ts). Most commits
# carry none, by design: the model is told to omit the line for anything invisible from outside the project, so
# this section is the release's handful of real changes rather than a second copy of the subject list below it.
#
# THIS SECTION IS AN API. The site's changelog page and the sandbox's "Update available" card both read these
# bullets back off the published Release, which is what makes the Release body the ONE editable source: fixing a
# bad note here, by hand, after the fact, corrects every surface that quotes it. Keep the heading spelling and
# the `- ` bullets — both are parsed (_site/site/src/lib/changelog.ts).
#
# Deduplicated, because identical work routinely lands as several identical commits (five in v1.184.0), and each
# one carries the same sentence. `awk '!seen[$0]++'` keeps the first of each in git's own newest-first order.
whats_new="$(git log --no-merges --format='%(trailers:key=Release-Note,valueonly)' "$range" |
  grep -v '^[[:space:]]*$' | awk '!seen[$0]++' | sed 's/^/- /' || true)"

# WHAT THIS RELEASE TAKES AWAY, above everything else — the `Breaking-Note:` trailers, same pipeline and same
# dedup as the notes. This heading is part of the same API as "What's new": the changelog page and the update
# card both parse it back off the Release body, and the card treats its presence as "warn before updating, and
# ask for an acknowledgment" — so a release must carry this section exactly when a commit declared a break,
# and the spelling must not drift.
breaking="$(git log --no-merges --format='%(trailers:key=Breaking-Note,valueonly)' "$range" |
  grep -v '^[[:space:]]*$' | awk '!seen[$0]++' | sed 's/^/- /' || true)"

notes="$(
  if [ -n "$breaking" ]; then printf "## Breaking changes\n\n%s\n\n" "$breaking"; fi
  if [ -n "$whats_new" ]; then printf "## What's new\n\n%s\n\n" "$whats_new"; fi
  section Features '^feat(\(|!?:)'
  section Fixes '^fix(\(|!?:)'
  section Other -v '^(feat|fix)(\(|!?:)'
)"

# --- the Release + its assets -------------------------------------------------------------------------------
# The tag is NOT created here. semantic-release creates and pushes it between prepare and publish — "create the
# tag before calling the publish plugins as some require the tag to exists" is its own comment — and this script
# is one of those plugins. Tagging here as well is what made every real release die at `fatal: tag 'vX.Y.Z'
# already exists`: the Release and its assets went out, then semantic-release aborted on the second tag, taking
# the container images and the `stable` pointer down with it.
release_id="$(api "https://api.github.com/repos/${REPO}/releases/tags/${TAG}" 2>/dev/null | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id' 2>/dev/null || true)"
if [ -z "$release_id" ]; then
  echo "==> creating release ${TAG}"
  # make_latest: false — A NEW RELEASE IS BETA, NOT LATEST. Every download surface (`releases/latest/download`
  # in the connect scripts, the site's download links) and every stable sandbox's update check follows the
  # "latest" flag, and promote-stable.sh flips it only after the release has soaked on the beta lane. Creating
  # a release as latest here would hand an unsoaked build to every stable user the moment it tagged.
  release_id="$(
    node -pe 'JSON.stringify({tag_name: process.argv[1], name: process.argv[1], body: process.argv[2], make_latest: "false"})' "$TAG" "$notes" |
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
for f in _sandbox/sync/dist-bin/* _computers/host/dist-bin/* _sandbox/ic/dist-bin/* _editor/desktop-app/dist-bin/*; do
  upload_one "$f" &
  pids+=("$!")
done

failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=1
done
[ "$failed" -eq 0 ] || { echo "one or more release assets failed to upload" >&2; exit 1; }

echo "==> https://github.com/${REPO}/releases/tag/${TAG}"
