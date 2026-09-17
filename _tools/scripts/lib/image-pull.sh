#!/usr/bin/env bash
# Pull an image onto this runner, and tell a REGISTRY fault apart from an IMAGE STORE one.
#
#   . "$(dirname "$0")/../lib/image-pull.sh"
#   image_pull ghcr.io/intentic/sandbox:1.285.0-amd64
#
# A pull is two halves with nothing in common. The first is a conversation with ghcr.io, and registry-retry.sh
# is the whole judgment about it — rate limits, dropped uploads, a dial that was never answered. The second
# happens after the last byte has landed: the layers are unpacked into this daemon's image store, each onto the
# snapshot the one below it left behind. That store is SHARED MUTABLE STATE on a host this pipeline does not
# have to itself — six runner processes, the owner's own sandboxes, and a disk reconciler that prunes — and a
# chain that loses a link mid-unpack fails the pull with every byte already in hand:
#
#   failed to prepare extraction snapshot "extract-867389931-0Kfz sha256:278bf3cda023":
#   NotFound: parent snapshot sha256:ceeb23b44c46 does not exist: not found
#
# THAT IS WHAT KILLED RELEASE 1.285.0. Both halves had built and pushed clean, the smoke gate pulled the
# standard half back to boot it, every layer of that very pull reported "Download complete" — and the unpack
# died on a parent that was there when the extraction started. Sixty seconds later the core half unpacked its
# own 5 GB off the same registry, onto the same daemon, without a complaint. Nothing was wrong with the image,
# the registry, or the tag.
#
# IT WAS REPORTED AS THE REGISTRY, which is the second half of the bug and the reason this file exists rather
# than another pattern in registry-retry.sh. The gate printed "the REGISTRY refused or dropped it, which says
# nothing about this image" over a registry that had just handed over 5 GB without an error — the same
# mis-diagnosis smoke-image.sh's own pull step was written to end, pointed one hop further out. A verdict that
# names the wrong culprit costs the next person the whole investigation.
#
# AND THE REMEDY IS NOT REGISTRY-RETRY'S REMEDY. That helper asks again, which is right for a refusal that is
# really a clock. Asking again HERE reproduces the same error until the attempts run out: the broken chain is
# on disk, and the next `docker pull` walks straight back onto it. What clears it is dropping the half-unpacked
# image first, so the extraction starts from a parent this daemon still holds.
IMAGE_PULL_ATTEMPTS="${IMAGE_PULL_ATTEMPTS:-3}"
IMAGE_PULL_DELAY="${IMAGE_PULL_DELAY:-5}"

# `image_pull` judges a failure through `cmd | tee`, whose status is tee's own unless this is set — without it
# a failed pull reports success and the container is started from an image that is not there. Every caller
# already sets it; set here too, because the judgment below is this file's and so is its precondition.
set -o pipefail

. "$(dirname "${BASH_SOURCE[0]}")/registry-retry.sh"

# THE FAULTS THAT ARE THIS DAEMON'S, and only those: an unpack that went looking for content the store no
# longer holds. Both spellings are the same event — containerd names the missing snapshot when the extraction
# has one to name, and the content digest when a blob was collected instead — and both are state that a fresh
# unpack rebuilds from bytes the registry still has.
#
# NOTHING ELSE BELONGS HERE. A full disk fails the unpack too ("failed to register layer: write ...: no space
# left on device") and must fail AT ONCE: re-pulling 5 GB onto a disk with no room for it is twenty minutes
# spent to print the same line. A tag that is not there, a token without `packages: read`, and every refusal
# registry-retry.sh already judges are the registry's, and reach this predicate only to be declined by it.
# Both directions are asserted, against the text 1.285.0 actually printed, by the `publish-retry` check
# (_tools/checks/publish-retry.mjs), which reads the pattern list below back out of this file.
image_pull_unpack_fault() {
    grep -Eqi \
        -e 'parent snapshot [^ ]+ does not exist' \
        -e 'failed to prepare extraction snapshot.*(does not exist|not found)' \
        -e 'content digest [^ ]+: not found' \
        -- "$1"
}

# Run the pull, streaming it (a 5 GB pull must not go quiet for the sake of being judged) while keeping a copy
# to judge a failure by. The registry's own transient set is handled inside `registry_retry`; what comes back
# failed is either an unpack this function can clear or a verdict worth printing.
image_pull() { # <image-ref>
    local image="$1" attempt=1 status log
    log="$(mktemp)"
    while :; do
        status=0
        registry_retry docker pull "$image" 2>&1 | tee "$log" || status=$?
        if [ "$status" -eq 0 ]; then
            rm -f "$log"
            return 0
        fi
        if ! image_pull_unpack_fault "$log"; then
            rm -f "$log"
            echo "  ✗ could not pull $image — the REGISTRY refused or dropped it, which says nothing about this image" >&2
            return "$status"
        fi
        if [ "$attempt" -ge "$IMAGE_PULL_ATTEMPTS" ]; then
            rm -f "$log"
            echo "  ✗ could not unpack $image — this runner's IMAGE STORE lost a layer under the extraction $IMAGE_PULL_ATTEMPTS times running, which says nothing about this image or the registry: every byte arrived" >&2
            return "$status"
        fi
        echo "==> the image store lost a layer of $image mid-unpack (attempt $attempt/$IMAGE_PULL_ATTEMPTS) — dropping what was unpacked and pulling it again" >&2
        # The half-unpacked image, which is what the retry would otherwise walk back onto. Best-effort: there
        # is nothing to remove when the pull died before it tagged anything, and that is not a failure.
        docker image rm -f "$image" >/dev/null 2>&1 || true
        sleep "$IMAGE_PULL_DELAY"
        attempt=$((attempt + 1))
    done
}
