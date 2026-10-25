#!/usr/bin/env bash
# Run actionlint for workflow validity and zizmor for injection, credentials and supply-chain rules; exceptions live in .github/zizmor.yml.
# Cache pinned binaries instead of relying on ci-base, so a PR adding the tool can run before its new image is published.
# Verify sha256 before execution: actionlint uses upstream checksums; zizmor's recorded download hash is trust-on-first-use.
# Re-verify each hash when bumping versions and retain that distinction.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
cd "$(repo_root)"

ACTIONLINT_VERSION=1.7.12
ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
ZIZMOR_VERSION=1.29.0
ZIZMOR_SHA256=dd96df044a6e8538d5f423790f453bdd03d49e5b2bcc38214acc41a2f1297839

# The shared cache when the fleet's mount is there, the working tree when it is not — the same "absent mount
# falls back cold, never broken" rule ci.yml states for the pnpm and turbo stores. A developer running this
# from a laptop or an agent worktree gets .cache/ and pays one download.
CACHE_ROOT="${WORKFLOW_LINTER_DIR:-/ci-cache/workflow-linters}"
mkdir -p "$CACHE_ROOT" 2>/dev/null || CACHE_ROOT="$(repo_root)/.cache/workflow-linters"
mkdir -p "$CACHE_ROOT"

# Fetch, verify, unpack, publish — in that order, and the publish is a rename so six runner processes racing
# on one cache directory cannot see a half-extracted tool. (That is not a hypothetical failure mode here: a
# half-written corepack cache is exactly what cost a runner 15 minutes, per _tools/ci-base/Dockerfile, which
# is why pnpm is no longer fetched that way at all.)
install_tool() {
    local name="$1" version="$2" sha256="$3" url="$4" member="$5"
    local dest="$CACHE_ROOT/$name-$version"
    if [ -x "$dest/$name" ]; then
        echo "  cached   $name $version"
        return 0
    fi
    local work
    work="$(mktemp -d "$CACHE_ROOT/.$name.XXXXXX")"
    # shellcheck disable=SC2064 — expand $work now, so the trap removes THIS directory whatever happens later.
    trap "rm -rf '$work'" RETURN
    echo "  fetch    $name $version"
    curl -fsSL --retry 3 --retry-delay 2 -o "$work/archive.tar.gz" "$url"
    echo "$sha256  $work/archive.tar.gz" | sha256sum --check --status \
        || { echo "$name $version: sha256 mismatch — the release asset is not the bytes this file pins" >&2; exit 1; }
    tar xzf "$work/archive.tar.gz" -C "$work" "$member"
    chmod +x "$work/$member"
    mkdir -p "$work/staged"
    mv "$work/$member" "$work/staged/$name"
    # Atomic against a concurrent installer; if another job won the race its copy is equally valid, so a
    # failure here is not a failure of the run.
    mv -T "$work/staged" "$dest" 2>/dev/null || true
    [ -x "$dest/$name" ] || { echo "$name $version: install did not land at $dest" >&2; exit 1; }
}

install_tool actionlint "$ACTIONLINT_VERSION" "$ACTIONLINT_SHA256" \
    "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" \
    actionlint
install_tool zizmor "$ZIZMOR_VERSION" "$ZIZMOR_SHA256" \
    "https://github.com/zizmorcore/zizmor/releases/download/v${ZIZMOR_VERSION}/zizmor-x86_64-unknown-linux-gnu.tar.gz" \
    zizmor

echo "actionlint:"
# Finds .github/workflows itself and reads .github/actionlint.yaml for the fleet's labels. `-oneline` because
# the default multi-line form buries the file:line under a code excerpt in a CI log.
"$CACHE_ROOT/actionlint-$ACTIONLINT_VERSION/actionlint" -no-color -oneline
echo "  clean"

echo "zizmor:"
# Run with no confidence floor so new credential-persisting checkouts cannot silently erode the fixes.
# Deliberate exceptions live in .github/zizmor.yml or inline beside the specific step and its reason.
"$CACHE_ROOT/zizmor-$ZIZMOR_VERSION/zizmor" \
    --no-progress --no-online-audits \
    --config .github/zizmor.yml .github/workflows/ .github/actions/
