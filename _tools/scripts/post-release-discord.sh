#!/usr/bin/env bash
# Post a release highlight to the community Discord #announcements webhook.
# Reads the published GitHub Release body and quotes the same "## What's new" / "## Breaking changes"
# sections the site changelog and sandbox update card use — not the commit-subject list below them.
#
# WHY THE `success` STEP AND NOT publishCmd. .releaserc.json runs this after mark-release-cut.sh, which is the
# only point where a release is finished rather than in progress: publishCmd is still stitching image
# manifests and has not flipped make_latest yet (ship-stable.sh), so announcing from inside it would tell the
# community about a version that `releases/latest/download` does not serve and that a later failure can leave
# half-shipped. A Discord message cannot be un-sent the way a pointer can be rolled back.
#
# Skips quietly when the release has no user-facing notes (internal-only ship), unless FORCE=1 — roughly half
# of this repository's releases are invisible to users and posting them would train people to mute the
# channel. A failed post is never fatal: the release already shipped, and failing here would report a red
# pipeline for a green release.
#
#   DISCORD_RELEASE_WEBHOOK=https://discord.com/api/webhooks/… bash post-release-discord.sh 1.234.0
#   DRY_RUN=1 …   # print the exact message that would be posted, post nothing
#   FORCE=1 …     # post even when the release has no user-facing notes
set -euo pipefail
VERSION="${1:?usage: post-release-discord.sh <version>}"
. "$(dirname "$0")/repo-root.sh"
cd "$(repo_root)"

REPO="${GITHUB_REPOSITORY:-intentic/intentic}"
TAG="v${VERSION}"
WEBHOOK="${DISCORD_RELEASE_WEBHOOK:-}"
FORCE="${FORCE:-0}"
DRY_RUN="${DRY_RUN:-0}"
LIMIT="${DISCORD_RELEASE_BULLET_LIMIT:-8}"

if [ -z "$WEBHOOK" ]; then
  echo "  skip     discord release post (no DISCORD_RELEASE_WEBHOOK)"
  exit 0
fi

gh_api() {
  curl --fail --silent --show-error \
    --header "Accept: application/vnd.github+json" \
    --header "X-GitHub-Api-Version: 2022-11-28" \
    ${GITHUB_TOKEN:+--header "Authorization: Bearer ${GITHUB_TOKEN}"} \
    "$@"
}

release_json="$(gh_api "https://api.github.com/repos/${REPO}/releases/tags/${TAG}" 2>/dev/null || true)"
if [ -z "$release_json" ]; then
  echo "  skip     discord release post (release ${TAG} not found)" >&2
  exit 0
fi

body="$(printf '%s' "$release_json" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).body ?? ""')"
html_url="$(printf '%s' "$release_json" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).html_url ?? ""')"

# Same section contract as publish-github.sh / changelog.ts / release-notes.ts.
section_bullets() {
  local heading="$1"
  node - "$heading" "$body" <<'NODE'
const label = process.argv[2];
const lines = process.argv[3].split(/\r?\n/);
const heading = new RegExp(`^##\\s+${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
const start = lines.findIndex((line) => heading.test(line.trim()));
if (start === -1) process.exit(0);
const out = [];
for (const line of lines.slice(start + 1)) {
  const t = line.trim();
  if (t.startsWith("#")) break;
  if (t.startsWith("- ")) out.push(t.slice(2).trim());
}
process.stdout.write(out.filter(Boolean).join("\n"));
NODE
}

breaking="$(section_bullets "Breaking changes")"
notes="$(section_bullets "What's new")"

if [ -z "$breaking" ] && [ -z "$notes" ] && [ "$FORCE" != "1" ]; then
  echo "  skip     discord release post (${TAG} has no user-facing notes)"
  exit 0
fi

format_bullets() {
  local text="$1" max="$2" prefix="$3"
  [ -z "$text" ] && return 0
  local count=0 extra=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    count=$((count + 1))
    if [ "$count" -le "$max" ]; then
      printf '%s• %s\n' "$prefix" "$line"
    else
      extra=$((extra + 1))
    fi
  done <<< "$text"
  if [ "$extra" -gt 0 ]; then
    printf '%s_…and %s more in the full release notes._\n' "$prefix" "$extra"
  fi
}

release_url="${html_url:-https://github.com/${REPO}/releases/tag/${TAG}}"
msg=$(
  {
    printf '🚀 **intentic %s**\n\n' "$TAG"
    if [ -n "$breaking" ]; then
      printf '⚠️ **Breaking changes**\n'
      format_bullets "$breaking" "$LIMIT" ""
      printf '\n'
    fi
    if [ -n "$notes" ]; then
      printf '**What'\''s new**\n'
      format_bullets "$notes" "$LIMIT" ""
      printf '\n'
    fi
    printf '📦 [Release notes](%s) · [Changelog](https://intentic.dev/changelog)' "$release_url"
  }
)

# Discord caps a message at 2000 characters. Count them in node rather than bytes with `head -c`, which cuts
# a multi-byte character in half and leaves invalid UTF-8 in the payload. flags 4 = SUPPRESS_EMBEDS: without
# it the two trailing links unfurl into preview cards twice the height of the notes themselves.
payload="$(node -pe '
const content = process.argv[1];
JSON.stringify({ content: content.length > 2000 ? content.slice(0, 1999) + "…" : content, flags: 4 });
' "$msg")"

if [ "$DRY_RUN" = "1" ]; then
  printf '%s' "$payload" | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).content'
  exit 0
fi

if ! curl --fail --silent --show-error \
  --header "Content-Type: application/json" \
  --data-binary "$payload" \
  --max-time 30 \
  "$WEBHOOK" >/dev/null; then
  echo "  warn     discord release post failed (non-fatal)" >&2
  exit 0
fi

echo "  posted   discord release ${TAG}"
