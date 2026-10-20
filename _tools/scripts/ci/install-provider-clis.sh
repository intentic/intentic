#!/usr/bin/env bash
# Install the provider CLIs the conformance tier drives, AT THE VERSIONS THE PACKS PIN.
#
# The tier's whole claim is that it exercises the shipped article, so installing "the latest codex" would quietly
# make it a test of something the product does not run. The pins therefore come from the pack Dockerfiles rather
# than from a copy here: those files are what the image builds from, packs.integration.test.ts already holds them
# in lockstep with the daemon's own dependency versions, and a second list in a shell script is the third place
# the same number would have to be right.
#
#   install-provider-clis.sh            installs every provider CLI at its pinned version
#   install-provider-clis.sh --latest   installs the newest instead: the nightly canary's job, which is to find
#                                       out that a vendor changed something BEFORE a pin bump lands it on users
#
# Idempotent: a CLI already at the wanted version is left alone, so a warm CI runner pays nothing.
set -euo pipefail

# Found, not counted: `cd "$(dirname "$0")/../.."` is right only for this file's current location and nothing
# checks it, which is the whole reason repo-root.sh exists.
. "$(dirname "$0")/../lib/repo-root.sh"
packs="$(repo_root)/_sandbox/sandbox/image-packs"
latest=0
[ "${1:-}" = "--latest" ] && latest=1

# The pinned spec out of a pack file, by the same shape packs.integration.test.ts reads. A pack that stops
# matching is a failure rather than an empty string: silently installing nothing would leave the tier "passing"
# against whatever happened to be on PATH.
pin_from() {
    local file="$1" pattern="$2" found
    found="$(grep -oE "${pattern}" "${file}" | head -1 || true)"
    if [ -z "${found}" ]; then
        echo "install-provider-clis: no pin matching ${pattern} in ${file}" >&2
        exit 1
    fi
    printf '%s' "${found}"
}

# Three tries, because a download that fails is not always a failure npm reports as one. OpenCode 2 ships each build as
# an OPTIONAL dependency of about 200 MB, and npm drops an optional one whose download fails without saying why; its
# postinstall then finds no build for this runner and fails the step (verify-providers on radarsu-worker-1, 2026-10-20:
# three of the four linux-x64 tarballs never arrived, and the musl one that did does not run on glibc). Another try
# fetches what is missing; a real refusal (a pin that does not exist) fails all three the same way.
install_npm() {
    local name="$1" spec="$2" try
    if [ "${latest}" = "1" ]; then
        spec="${name}@latest"
    fi
    for try in 1 2 3; do
        echo "==> ${spec}$([ "${try}" -gt 1 ] && echo " (try ${try} of 3)")"
        if npm install -g "${spec}"; then
            return 0
        fi
        [ "${try}" -lt 3 ] && sleep $((try * 15))
    done
    echo "install-provider-clis: ${spec} did not install in three tries" >&2
    return 1
}

install_npm "@openai/codex" "$(pin_from "${packs}/codex.Dockerfile" '@openai/codex@[0-9][0-9.]*')"
install_npm "@opencode/cli" "$(pin_from "${packs}/opencode.Dockerfile" '@opencode/cli@[0-9][0-9.]*')"
# OpenCode 2 fetches every build for the runner's OS and CPU (about 200 MB each) and links the one this runner uses into its bin; the
# rest are dropped, as the pack does, so a warm runner's cache does not carry four copies.
rm -rf "$(npm root -g)"/@opencode/cli/node_modules/@opencode/cli-* "$(npm root -g)"/@opencode/cli-*

# @cursor/sdk is a MODULE the daemon imports, not a CLI on PATH, and its licence grants no redistribution, so it
# is installed into the prefix the daemon resolves from (cursor-sdk.ts, INTENTIC_CURSOR_SDK_DIR) exactly as the
# pack does, rather than globally.
cursor_spec="$(pin_from "${packs}/cursor.Dockerfile" '@cursor/sdk@[0-9][0-9.]*')"
[ "${latest}" = "1" ] && cursor_spec="@cursor/sdk@latest"
echo "==> ${cursor_spec} (into ${INTENTIC_CURSOR_SDK_DIR:-/opt/cursor-sdk})"
npm install --prefix "${INTENTIC_CURSOR_SDK_DIR:-/opt/cursor-sdk}" --no-save --no-package-lock "${cursor_spec}"

echo "==> installed:"
codex --version || true
opencode --version || true
node -e "console.log('@cursor/sdk', require('${INTENTIC_CURSOR_SDK_DIR:-/opt/cursor-sdk}/node_modules/@cursor/sdk/package.json').version)" || true
