#!/usr/bin/env bash
# THE GITHUB API, SPELLED ONCE — for the six release scripts that all talk to it.
#
#   . "$(dirname "$0")/../lib/github.sh"
#   GH_API_TOKEN="$GITHUB_TOKEN"
#   gh_require_token "this tag is what every publish workflow is dispatched against"
#   id="$(gh_release_id "$REPO" "$TAG")"
#
# WHAT THIS REPLACES. Seven scripts each carried their own `api()` — the same four curl headers, differing only
# in whitespace — and five of them re-spelled `node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id'`
# eleven times between them to read ONE field back. Three looked a release up by tag, two flipped `make_latest`,
# two force-pushed the same `stable` tag, two walked the asset list to skip an upload GitHub would 422. Every
# one of those is a decision this repository makes once; having it written seven times means six of them are
# out of date the day the seventh changes, and nothing anywhere would say so.
#
# THE TOKEN IS NAMED, NOT ASSUMED. `GH_API_TOKEN` rather than `$GITHUB_TOKEN` directly, because publish-action
# talks to a DIFFERENT repository with a different credential (GATE_ACTION_TOKEN) and the difference has to be
# visible at the call site rather than buried in here. Unset is a programming error and fails loudly.
#
# EVERY FUNCTION THAT ASKS A QUESTION ANSWERS WITH TEXT OR NOTHING, never a curl error: a release that does not
# exist, an asset list that could not be read and a token that cannot see the repo are all "no answer", and the
# caller decides which of those is fatal. The ones that CHANGE something (upload, make_latest, the tag move)
# fail loudly instead, because a write that silently did not happen is the half-published release this whole
# directory exists to prevent.

# One authenticated call. Extra curl arguments pass straight through, which is what lets an upload point at
# uploads.github.com and a PATCH carry a body without a second wrapper.
gh_api() {
    curl --fail --silent --show-error \
        --header "Authorization: Bearer ${GH_API_TOKEN:?gh_api: set GH_API_TOKEN before calling}" \
        --header "Accept: application/vnd.github+json" \
        --header "X-GitHub-Api-Version: 2022-11-28" "$@"
}

# One top-level field of a JSON body on stdin, or empty. node rather than jq: node is on every runner and in
# every image this repo builds, and jq is not.
gh_field() {
    node -pe 'const v = JSON.parse(require("fs").readFileSync(0, "utf8"))[process.argv[1]]; v === undefined || v === null ? "" : String(v)' "$1" 2>/dev/null || true
}

# THE TOKEN, OR A DELIBERATE STAND-DOWN. Locally this skips so a release dry-run stays runnable; in CI it is
# fatal, and it has to be — a quiet skip on a real release leaves a tagged version whose artifacts nobody can
# reach and still reports green, which is the shape of how v1.177.0-v1.179.0 were tagged with nothing behind
# them. The argument is what is LOST without the token, said in the error rather than left to be inferred.
gh_require_token() {
    if [ -n "${GH_API_TOKEN:-}" ]; then
        return 0
    fi
    if [ -n "${CI:-}" ]; then
        echo "no API token — $1, so this is fatal in CI." >&2
        exit 1
    fi
    echo "  skip     $1 (no token, not CI)"
    exit 0
}

# The id of a release by tag, or empty when there is none. Never fatal: "does this release exist yet" is a
# question two of the callers ask precisely because the answer may be no.
gh_release_id() {
    gh_api "https://api.github.com/repos/$1/releases/tags/$2" 2>/dev/null | gh_field id
}

# The tag a repository currently serves as `latest` (the flag every download link and update check follows), or
# empty.
gh_latest_tag() {
    gh_api "https://api.github.com/repos/$1/releases/latest" 2>/dev/null | gh_field tag_name
}

# Create a release and answer with its id. The notes are passed as an ARGUMENT to node and serialized there,
# never spliced into a shell command: release notes are free text written by whoever wrote the commit, and a
# backtick or a `$(` in one would otherwise be a command this script runs.
#
# `make_latest` is a string ("true"/"false") because that is what the API takes, and the default is "false" for
# the reason publish-github.sh gives at length: a release has no assets attached until its uploads finish, and
# flagging it latest before then points every connect one-liner at a 404.
gh_create_release() {
    local repo="$1" tag="$2" notes="$3" latest="${4:-false}"
    node -pe 'JSON.stringify({ tag_name: process.argv[1], name: process.argv[1], body: process.argv[2], make_latest: process.argv[3] })' \
        "$tag" "$notes" "$latest" |
        gh_api --header "Content-Type: application/json" --data-binary @- "https://api.github.com/repos/$repo/releases" |
        gh_field id
}

# The names of a release's attached assets, one per line — what an idempotent upload checks before it spends
# the bytes, since GitHub 422s a duplicate name.
gh_asset_names() {
    gh_api "https://api.github.com/repos/$1/releases/$2/assets?per_page=100" 2>/dev/null |
        node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).map((a) => a.name).join("\n")' 2>/dev/null || true
}

# Attach one file. The name defaults to the file's own basename, and is passed explicitly by the caller that
# renames as it uploads (the provenance bundle).
gh_upload_asset() {
    local repo="$1" release_id="$2" file="$3" name="${4:-}"
    [ -n "$name" ] || name="$(basename "$file")"
    gh_api --output /dev/null --header "Content-Type: application/octet-stream" \
        --data-binary "@${file}" \
        "https://uploads.github.com/repos/${repo}/releases/${release_id}/assets?name=${name}"
}

# Flip the flag the whole world follows: `releases/latest/download/*` — every connect script and every site
# download link — and every sandbox's update check.
gh_make_latest() {
    printf '{"make_latest":"true"}' |
        gh_api --request PATCH --header "Content-Type: application/json" --data-binary @- \
            --output /dev/null "https://api.github.com/repos/$1/releases/$2"
}

# Move the git `stable` tag onto a release tag — the browsable stable source pointer. The fetch is best-effort:
# semantic-release pushed the release tag between prepare and publish, so it is on the remote already and this
# needs no local tag object; the fetch only makes the push work from a clone that has one.
gh_move_stable_tag() {
    git fetch --quiet origin "refs/tags/$1:refs/tags/$1" 2>/dev/null || true
    git push --quiet --force origin "refs/tags/$1:refs/tags/stable"
}
