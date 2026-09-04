#!/usr/bin/env bash
# Sync the built GitHub Action to the public intentic/gate-action repository — the Marketplace artifact.
#
# A Marketplace listing requires a public repository with action.yml at its ROOT, one action per repo, so the
# action cannot be served from the monorepo the way every npm package is. This script ships a snapshot instead:
# the tree it pushes is action.yml, the self-contained bundle, the marketplace README and the license — nothing
# else, assembled fresh every release and committed OVER whatever is there. That repo is a build artifact and
# says so in its README; unlike the mirror that once burned this repo (see publish-github.sh's header), nobody
# develops in it, so replacing the tree whole is the correctness guarantee rather than the accident.
#
# Runs from .github/workflows/action-publish.yml on the `v*` tag semantic-release pushes, after the bundle is
# built. Idempotent like publish-npm.sh: a version already tagged on the action repo is SKIPPED, so a re-run
# only completes whatever didn't land (the floating major tag, the Release).
#
# CI setup: GATE_ACTION_TOKEN, a fine-grained PAT with Contents: read+write on intentic/gate-action. Missing —
# or present but unable to write, which reads identically from here — this SKIPS — loudly, even in CI: the sync
# is meant to stay inert until the public repo and a usable secret exist, and a red release train over an
# optional artifact would teach everyone to ignore red. The write check is the probe below. The first Marketplace
# listing itself is a one-time manual step on the repo's first release (the developer agreement and categories
# can only be accepted in the UI); every release after that shows up on the listing by itself.
#   bash _tools/scripts/release/publish-action.sh 1.187.0
set -euo pipefail
VERSION="${1:?usage: publish-action.sh <version>}"
. "$(dirname "$0")/../lib/repo-root.sh"
. "$(dirname "$0")/../lib/github.sh"
cd "$(repo_root)"

TAG="v${VERSION}"
MAJOR="v${VERSION%%.*}"
ACTION_REPO="intentic/gate-action"
SRC="_sandbox/gate-action"
# A DIFFERENT repository and a DIFFERENT credential from every other script here, which is why lib/github.sh
# reads the token from a named variable rather than reaching for GITHUB_TOKEN itself.
GH_API_TOKEN="${GATE_ACTION_TOKEN:-}"

if [ -z "$GH_API_TOKEN" ]; then
  echo "  skip     ${ACTION_REPO} sync (no GATE_ACTION_TOKEN — create the public repo and add the secret to turn this on)"
  exit 0
fi
[ -f "$SRC/dist/index.mjs" ] || { echo "$SRC/dist/index.mjs missing — build the package before publishing" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git clone --quiet --depth 1 "https://x-access-token:${GH_API_TOKEN}@github.com/${ACTION_REPO}.git" "$work/repo"

# A TOKEN THAT CANNOT WRITE IS THE SAME SITUATION AS NO TOKEN, and until this probe existed it was not treated
# like one: the sync ran to the first push and died there with exit 128, taking the release train red over the
# one artifact this file's header calls optional. The clone above proves nothing, because the action repo is
# PUBLIC — git sends no credential for a read that is not challenged, so a token that is expired, scoped to the
# wrong account, or simply missing Contents: write clones perfectly and is refused three commands later
# ("Permission to ${ACTION_REPO} denied to <user>", 403). Worse than red: the refusal can land BETWEEN pushes,
# leaving the public repo with a commit whose version tag never arrived.
#
# `push --dry-run` is that check and there is no lighter one. It negotiates git-receive-pack — the write
# service, so the 403 comes back exactly as it would for the real push — while HEAD is still the ref we cloned,
# so there is nothing to send and nothing that can be written by the probe itself. An API permission read would
# be a weaker answer: it reports what the ACCOUNT may do, not what THIS token may do.
#
# Refusal skips loudly, with a `::warning::` so the run carries the reason on its summary rather than in a log
# nobody opens — the release stays green, and the fix is one setting on the PAT, not a revert. Anything else
# (network, DNS, the repo gone) is not a permission answer and still fails.
if ! probe="$(git -C "$work/repo" push --dry-run --quiet origin "HEAD:refs/heads/main" 2>&1)"; then
  case "$probe" in
    *"denied to"*|*"Permission to"*|*"Authentication failed"*|*"Invalid username or token"*|*"403"*|*"Repository not found"*)
      echo "::warning title=gate-action not published::GATE_ACTION_TOKEN cannot write to ${ACTION_REPO}, so ${TAG} was not synced to the Marketplace action repo. Give the token Contents: read+write on that repo (or replace it) and re-run the action publish workflow against the tag."
      echo "  skip     ${ACTION_REPO}@${TAG} (GATE_ACTION_TOKEN cannot write to ${ACTION_REPO})"
      echo "$probe" | sed 's/^/           /'
      exit 0
      ;;
    *)
      echo "$probe" >&2
      echo "${ACTION_REPO}: push probe failed for a reason that is not a permission refusal — treating it as fatal" >&2
      exit 1
      ;;
  esac
fi

# The version tag is immutable once out, like an npm version: workflows pin `@vX.Y.Z` and a tag that moves
# under them is a supply-chain incident, not a fix. Only the floating major and the Release are completed on
# a re-run; a wrong artifact ships as the next version.
if git -C "$work/repo" ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "  skip     ${ACTION_REPO}@${TAG} (already tagged)"
else
  # `git rm` rather than starting from empty so deletions ship too; nothing matches on the repo's first ever
  # sync, hence the `|| true`.
  git -C "$work/repo" rm -rq . 2>/dev/null || true
  mkdir -p "$work/repo/dist"
  cp "$SRC/action.yml" "$work/repo/action.yml"
  cp "$SRC/dist/index.mjs" "$work/repo/dist/index.mjs"
  cp "$SRC/marketplace/README.md" "$work/repo/README.md"
  # MIT asks for the notice in "all copies or substantial portions" — same reasoning as publish-npm.sh.
  cp LICENSE "$work/repo/LICENSE"
  git -C "$work/repo" add -A
  if git -C "$work/repo" diff --cached --quiet && git -C "$work/repo" rev-parse -q --verify HEAD >/dev/null; then
    echo "  skip     ${ACTION_REPO} commit (tree unchanged)"
  else
    git -C "$work/repo" -c user.name=intentic -c user.email=agent@intentic.dev commit -qm "${TAG}"
    git -C "$work/repo" push -q origin HEAD:main
  fi
  echo "  publish  ${ACTION_REPO}@${TAG}"
  git -C "$work/repo" tag "$TAG"
  git -C "$work/repo" push -q origin "$TAG"
fi

# The floating major is what the copyable snippet names (`intentic/gate-action@v1`) — it MOVES, that is its
# job, so it is forced on every release.
git -C "$work/repo" fetch -q origin "refs/tags/${TAG}:refs/tags/${TAG}" 2>/dev/null || true
git -C "$work/repo" tag -f "$MAJOR" "$TAG"
git -C "$work/repo" push -qf origin "$MAJOR"

# The Release is what the Marketplace listing surfaces. Created only when missing, so a re-run completes a
# half-done publish instead of 422ing on it. The body points home: the action's real notes are the monorepo
# release it was built from.
if [ -z "$(gh_release_id "$ACTION_REPO" "$TAG")" ]; then
  gh_create_release "$ACTION_REPO" "$TAG" \
    "Built from [intentic/intentic ${TAG}](https://github.com/intentic/intentic/releases/tag/${TAG}) — its release notes are this action's." >/dev/null
fi

echo "==> https://github.com/${ACTION_REPO}/releases/tag/${TAG}"
