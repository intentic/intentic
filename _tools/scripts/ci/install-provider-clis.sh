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

# Three tries for registry downloads. OpenCode's platform build is required explicitly: npm can silently drop a failed
# optional download, leaving postinstall to report only "Failed to install OpenCode". These jobs run on Debian/glibc;
# require the build postinstall prefers on this CPU, at the launcher's exact version.
install_npm() {
    local name="$1" spec="$2" try platform
    local -a extra=()
    if [ "${latest}" = "1" ]; then
        spec="${name}@latest"
    fi
    if [ "${name}" = "@opencode/cli" ]; then
        if [ "${latest}" = "1" ]; then
            spec="${name}@$(npm view "${spec}" version)"
        fi
        case "$(node -p process.arch)" in
            x64)
                platform=linux-x64-baseline
                if grep -qw avx2 /proc/cpuinfo; then platform=linux-x64; fi
                ;;
            arm64) platform=linux-arm64 ;;
            *) echo "install-provider-clis: unsupported OpenCode architecture" >&2; return 1 ;;
        esac
        extra=(--omit=optional "${name}-${platform}@${spec##*@}")
    fi
    for try in 1 2 3; do
        echo "==> ${spec}$([ "${try}" -gt 1 ] && echo " (try ${try} of 3)")"
        if npm install -g --foreground-scripts "${extra[@]}" "${spec}"; then
            return 0
        fi
        [ "${try}" -lt 3 ] && sleep $((try * 15))
    done
    echo "install-provider-clis: ${spec} did not install in three tries" >&2
    return 1
}

install_npm "@openai/codex" "$(pin_from "${packs}/codex.Dockerfile" '@openai/codex@[0-9][0-9.]*')"
install_npm "@opencode/cli" "$(pin_from "${packs}/opencode.Dockerfile" '@opencode/cli@[0-9][0-9.]*')"
# Postinstall links the platform build into the launcher's bin; drop its source package, as the pack does.
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
