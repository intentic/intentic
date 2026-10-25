#!/usr/bin/env bash
# Shared release API helpers; callers explicitly set GH_API_TOKEN because Action publishing uses a different repository/credential.
# Queries return text or nothing so callers decide whether missing state is fatal; gh_latest_tag is the documented exception.
# Mutations fail loudly: an upload, latest flag or tag move must never silently leave a half-published release.

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
# reach and still reports a pass, which is the shape of how v1.177.0-v1.179.0 were tagged with nothing behind
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
# empty when it serves none: a repository with no released version answers 404 here, and that is an answer.
#
# ANY OTHER REFUSAL FAILS, with curl's words on stderr. Its caller withdraws the release this names
# (rollback-stable.sh), so a 5xx or a token that cannot see the repo read as "none is latest" would roll stable
# back and leave the bad release offered to every sandbox running it. The 404 is told apart on curl's own message,
# as the upload retry below does, since curl's status is 22 for every HTTP verdict alike.
gh_latest_tag() {
    local body log status=0
    log="$(mktemp)"
    body="$(gh_api "https://api.github.com/repos/$1/releases/latest" 2>"$log")" || status=$?
    if [ "$status" -ne 0 ] && ! grep -q 'returned error: 404' "$log"; then
        cat "$log" >&2
        rm -f "$log"
        return "$status"
    fi
    rm -f "$log"
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

# Upload retries classify curl output, not exit 22: transient server faults retry; auth, missing files and real 4xx refusals fail.
# After failure, inspect the named asset: uploaded means success despite a lost response; incomplete rows must be deleted before retry.
# _tools/checks/publish-retry.mjs exercises transient/fatal cases and recovery from lost or incomplete uploads.

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
