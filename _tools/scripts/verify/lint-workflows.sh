#!/usr/bin/env bash
# Lint the workflow files themselves — actionlint for correctness, zizmor for the security shapes.
#
#   bash _tools/scripts/verify/lint-workflows.sh
#
# WHY THIS EXISTS. The workflows are the part of this repository with the most privilege and the least review,
# and the failures they have produced all share one shape: something stopped happening and the pipeline said
# nothing. A trigger that could never fire (three times — the workflow-policy check now covers that one). An image
# tag no pipeline had ever pushed. A `${{ }}` expanded into a shell line as script rather than data. Two
# standard tools read all of that straight off the checkout, in about a second, and the checkout gate was growing a
# hand-written YAML line scanner to approximate a fraction of it.
#
# WHAT EACH ONE IS FOR, because they do not overlap:
#   actionlint  the workflow is VALID and COHERENT — expressions typecheck against the contexts they name,
#               `needs` edges point at jobs that exist, `runs-on` names a label the fleet actually carries
#               (.github/actionlint.yaml declares the three self-hosted ones), matrix keys resolve.
#   zizmor      the workflow is SAFE — template injection into `run:`, credential persistence, unpinned
#               actions and images, over-broad `secrets: inherit`. .github/zizmor.yml holds this repository's
#               deliberate exceptions, each with the reason and what would retire it.
#
# NOT BAKED INTO ci-base, unlike every other tool the jobs use, and the reason is the bootstrap edge ci.yml's
# header describes: a pull request that adds a tool to ci-base cannot use it, because the image is built there
# but only pushed from main. A linter that goes red on the very pull request adding it is a linter nobody
# lands. Two pinned binaries into the shared cache cost ~1s warm and a few seconds cold, once per runner.
#
# THE PINS ARE BYTES, NOT TAGS. Each tool is fetched at an exact version and checked against a sha256 before it
# is unpacked, so a moved release asset fails here instead of running. actionlint's hash is the one its own
# published checksums file states; zizmor publishes no checksum file for this asset, so its hash was recorded
# from the download — trust-on-first-use, which pins the bytes without vouching for them. Re-verify by hand
# when bumping either version, and note which kind of hash you are writing down.
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
# half-written corepack cache is exactly what cost a runner 15 minutes, per .github/actions/pnpm-setup.)
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
# AT FULL SENSITIVITY — no confidence floor, which is only possible because the findings were fixed rather
# than filtered. This started at 186 findings and ran at `--min-confidence high` to keep the gate meaningful
# while the Low-confidence backlog (34 `artipacked` — checkouts persisting the token into a workspace six jobs
# share) was still open. That backlog is now 2, both named by line in .github/zizmor.yml with the reason.
#
# The floor is gone deliberately: at `high`, adding a checkout without `persist-credentials: false` would have
# passed silently and the cleanup would have eroded one job at a time. Running with no floor is what makes the
# fix stick.
"$CACHE_ROOT/zizmor-$ZIZMOR_VERSION/zizmor" \
    --no-progress --no-online-audits \
    --config .github/zizmor.yml .github/workflows/ .github/actions/
