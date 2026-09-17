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
#
# The curl runs on its OWN line, its status swallowed by `|| true`, rather than piped straight into gh_field.
# Every caller sets `set -euo pipefail`, and under pipefail a `curl --fail | gh_field` pipeline answers with
# CURL's status, not the reader's — so the 404 that MEANS "no such release yet" killed the caller instead of
# answering it. That is exactly what happened to v1.246.0: publish-github.sh asked whether its brand-new tag
# already had a Release, got the expected 404, and died with curl's exit 22 and no output at all.
gh_release_id() {
    local body
    body="$(gh_api "https://api.github.com/repos/$1/releases/tags/$2" 2>/dev/null || true)"
    [ -n "$body" ] || return 0
    printf '%s' "$body" | gh_field id
}

# The tag a repository currently serves as `latest` (the flag every download link and update check follows), or
# empty. Same shape as gh_release_id, and for the same reason: a repository with no released version answers
# 404 here, and that is an answer rather than a failure.
gh_latest_tag() {
    local body
    body="$(gh_api "https://api.github.com/repos/$1/releases/latest" 2>/dev/null || true)"
    [ -n "$body" ] || return 0
    printf '%s' "$body" | gh_field tag_name
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

# A release's asset list as GitHub's own JSON, or empty. One place asks, because the two readers below want
# different halves of the same answer and a release has at most a few dozen assets.
gh_assets() {
    gh_api "https://api.github.com/repos/$1/releases/$2/assets?per_page=100" 2>/dev/null || true
}

# The names of a release's FINISHED assets, one per line — what an idempotent upload checks before it spends
# the bytes, since GitHub 422s a duplicate name.
#
# `state === "uploaded"` is the load-bearing word. GitHub writes the asset row when an upload STARTS and marks
# it uploaded only once every byte is in, so a refused upload can leave a row holding the name with nothing
# behind it. Reporting that as attached is worse than reporting nothing: the re-run skips it, ship-stable.sh
# flips `make_latest`, and the release goes out with an installer whose download is a 404.
gh_asset_names() {
    gh_assets "$1" "$2" |
        node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).filter((a) => a.state === "uploaded").map((a) => a.name).join("\n")' 2>/dev/null || true
}

# One asset by name, as `<id> <state>`, or empty when the release has no row under that name.
gh_asset_by_name() {
    gh_assets "$1" "$2" |
        node -pe 'const a = JSON.parse(require("fs").readFileSync(0, "utf8")).find((x) => x.name === process.argv[1]); a === undefined ? "" : a.id + " " + a.state' "$3" 2>/dev/null || true
}

# Detach one asset. Fails loudly, like every other write here.
gh_delete_asset() {
    gh_api --request DELETE --output /dev/null "https://api.github.com/repos/$1/releases/assets/$2"
}

# --- attaching a file, and the upload endpoint dropping it ---------------------------------------------------
# THE RELEASE'S HEAVIEST BYTES GO TO A DIFFERENT HOST THAN THE REST OF THE API. uploads.github.com takes the
# installers and the cross-compiled binaries — nineteen assets, a few hundred megabytes, all in flight at once
# because publish-github.sh sends them in parallel — and under that burst it answers some of them with its own
# 5xx:
#
#   curl: (22) The requested URL returned error: 500
#   curl: (22) The requested URL returned error: 504
#   one or more release assets failed to upload
#
# That is what killed v1.289.0 (run 35244797817): thirteen assets attached, six refused — three 500s and three
# 504s — and the publish died after the tag was already pushed, taking the container images and the `stable`
# pointer with it. Nothing was wrong with the files, the token or the release; the same bytes go up fine on the
# re-run, which is the whole argument for trying again rather than failing a version nobody can take back.
#
# A REFUSED UPLOAD MAY STILL HAVE LANDED, and may equally have left a half-written row holding the name, so
# every failure asks the release what it now holds under that name before deciding anything. Attached and
# `uploaded` is a write whose ANSWER was lost — the asset is up, and a second attempt would earn a 422 for a
# success. Attached in any other state is this attempt's wreckage: it is deleted, which frees the name and is
# itself reason enough for another attempt whatever the refusal said, because a name held by half an upload is
# state on GitHub's side rather than anything this repo can get wrong.
#
# ONLY THAT CLASS OF FAILURE RETRIES. A 401, 403, 404 or an unreadable file must fail on the FIRST attempt:
# four silent backoffs before the same error turns a red release into a slow red release that reads like a
# flake. So the decision is made on curl's own message, not on its exit status, which is 22 for every HTTP
# verdict alike. BOTH DIRECTIONS ARE ASSERTED, against the text v1.289.0 actually printed, by the
# `publish-retry` check (_tools/checks/publish-retry.mjs, shared with the registry and npm retries) — which
# reads the pattern list below back out of this file rather than keeping a second copy, and exercises the loop.

# Attempts and the base gap, in seconds. Jittered, because these uploads run in parallel and are refused
# TOGETHER: a fixed gap brings the whole burst back at the same instant, which is the burst that was refused.
GH_UPLOAD_ATTEMPTS="${GH_UPLOAD_ATTEMPTS:-4}"
GH_UPLOAD_DELAY="${GH_UPLOAD_DELAY:-10}"

# The refusals worth sending the bytes again. Matched on the MESSAGE: the status classes GitHub uses to say
# "later" (408, 429 and every 5xx), then the ordinary transport set — an endpoint under load cutting a
# multi-hundred-megabyte PUT short is the same "try it again" as an explicit 429. 4xx is otherwise absent on
# purpose: 401, 403, 404 and 422 are verdicts about US.
gh_upload_transient() {
    grep -Eqi \
        -e 'returned error: (408|429|5[0-9][0-9])' \
        -e 'transfer closed with' \
        -e 'empty reply from server' \
        -e '(recv|send) failure' \
        -e 'connection reset by peer' \
        -e 'operation timed out' \
        -e 'ssl connect error' \
        -e 'stream [0-9]+ was not closed cleanly' \
        -e 'failed to connect to' \
        -e 'could not resolve host' \
        -- "$1"
}

# Attach one file. The name defaults to the file's own basename, and is passed explicitly by the caller that
# renames as it uploads (the provenance bundle).
gh_upload_asset() {
    local repo="$1" release_id="$2" file="$3" name="${4:-}" attempt=1 status delay log found id state cleared
    [ -n "$name" ] || name="$(basename "$file")"
    log="$(mktemp)"
    while :; do
        status=0
        # curl's own words are kept to judge the failure by, and printed as they were on the way out: with
        # --silent --show-error there is nothing on stderr for an upload that worked.
        gh_api --output /dev/null --header "Content-Type: application/octet-stream" \
            --data-binary "@${file}" \
            "https://uploads.github.com/repos/${repo}/releases/${release_id}/assets?name=${name}" 2>"$log" || status=$?
        if [ "$status" -eq 0 ]; then
            rm -f "$log"
            return 0
        fi
        cat "$log" >&2

        cleared=no
        found="$(gh_asset_by_name "$repo" "$release_id" "$name")"
        if [ -n "$found" ]; then
            id="${found%% *}"
            state="${found#* }"
            if [ "$state" = uploaded ]; then
                rm -f "$log"
                echo "  landed   ${name} is attached after all — the upload went through and the answer did not" >&2
                return 0
            fi
            if gh_delete_asset "$repo" "$id"; then
                cleared=yes
            fi
        fi

        if [ "$attempt" -ge "$GH_UPLOAD_ATTEMPTS" ] || { [ "$cleared" = no ] && ! gh_upload_transient "$log"; }; then
            rm -f "$log"
            return "$status"
        fi
        delay=$((GH_UPLOAD_DELAY * attempt))
        if [ "$delay" -gt 0 ]; then
            delay=$((delay + RANDOM % delay))
        fi
        echo "==> ${name} was refused by GitHub's upload endpoint (attempt ${attempt}/${GH_UPLOAD_ATTEMPTS}) — waiting ${delay}s and attaching it again" >&2
        sleep "$delay"
        attempt=$((attempt + 1))
    done
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
