#!/usr/bin/env bash
# Hand Bubblewrap a runner it will accept, before either Android job runs it.
#
#   bash _tools/scripts/mobile-android-sdk.sh
#
# WHY THIS EXISTS. Bubblewrap keeps its toolchain answers in ~/.bubblewrap/config.json — the interactive `init`
# asks for them once on a laptop, and a runner has no one to ask, so the file is written here instead. Writing
# it was the whole of this step until the first run failed: `build` died on "The provided androidSdk isn't
# correct" against the SDK the runner image ships.
#
# The check behind that message (@bubblewrap/core, AndroidSdkTools.validatePath) asks for `tools/` or `bin/` AT
# THE SDK ROOT — where the command-line tools sat until SDK release 6858069 moved them under
# `cmdline-tools/<version>/`. Every current image ships the new layout, so the check fails on a perfectly good
# SDK. The symlink below is the whole fix: it gives the validator the root `bin/` it looks for, and it is also
# the path Bubblewrap's own sdkmanager fallback uses, while ANDROID_HOME keeps pointing at the real SDK — which
# is where Gradle, the platforms and the build tools have to be found.
#
# The licences are accepted for one reason: Bubblewrap pins ONE build-tools version and installs it mid-build
# if the SDK lacks it. That install is interactive when a licence is unaccepted, and an interactive prompt on a
# runner is a job that hangs until the timeout kills it, with the real cause scrolled off the top.
#
# DELETE THIS SCRIPT IF: Bubblewrap ever validates the cmdline-tools layout directly. Then both jobs go back to
# writing the config file inline, and nothing here has to know what the SDK looks like inside.
set -euo pipefail

# Fail loudly rather than writing an empty path into the config, where it reappears later as the same
# "isn't correct" message with nothing pointing at the cause.
SDK="${ANDROID_HOME:?the runner did not set ANDROID_HOME — no Android SDK to build against}"
JDK="${JAVA_HOME:?the runner did not set JAVA_HOME — setup-java must run before this script}"
# `latest` is where an sdkmanager-installed toolset lands and what the images use, but a version-numbered
# directory is equally valid — so `latest` first, then any of them. WHICH version is immaterial here: the two
# things this script asks of sdkmanager (accept licences, be on a path Bubblewrap will look at) are the same in
# all of them.
shopt -s nullglob
candidates=("$SDK/cmdline-tools/latest" "$SDK"/cmdline-tools/*)
shopt -u nullglob
TOOLS=""
for candidate in "${candidates[@]}"; do
    if [[ -x $candidate/bin/sdkmanager ]]; then
        TOOLS="$candidate"
        break
    fi
done
if [[ -z $TOOLS ]]; then
    echo "no cmdline-tools/*/bin/sdkmanager under $SDK — this image ships an SDK shape $0 has not seen" >&2
    ls -1 "$SDK" "$SDK/cmdline-tools" 2> /dev/null >&2 || true
    exit 1
fi
SDKMANAGER="$TOOLS/bin/sdkmanager"

# `-d` rather than `-e`, plus the `-L` arm: a real `bin/` directory (an image that went back to shipping one)
# must be left alone, because `ln` into an existing directory writes the link INSIDE it and the validator would
# still see nothing. A leftover symlink is replaced. The sudo arm is for an image that ships the SDK read-only —
# passwordless there, and a permission bit is a poor reason to lose a five-minute job.
if [[ ! -d $SDK/bin || -L $SDK/bin ]]; then
    ln -sfn "$TOOLS/bin" "$SDK/bin" 2> /dev/null || sudo ln -sfn "$TOOLS/bin" "$SDK/bin"
fi

# Idempotent: already-accepted licences are re-accepted silently. Redirected FROM a process substitution rather
# than piped: `yes | sdkmanager` dies 141 under `pipefail` the moment sdkmanager stops reading, which is every
# run where the licences were already in place.
"$SDKMANAGER" --licenses < <(yes) > /dev/null

mkdir -p ~/.bubblewrap
printf '{"jdkPath": "%s", "androidSdkPath": "%s"}\n' "$JDK" "$SDK" > ~/.bubblewrap/config.json

echo "bubblewrap: jdk $JDK, sdk $SDK (root bin -> ${TOOLS#"$SDK/"}/bin), licences accepted"
