#!/usr/bin/env bash
# image_pull separates registry transients (registry-retry.sh) from local extraction-store failures on shared runners.
# A missing parent snapshot can fail after every layer downloaded; another pull alone reuses the same broken chain.
# Drop the half-unpacked image before retrying local-store recovery, and report it as a store fault rather than a registry refusal.
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

# THE FAULT THAT IS THE IMAGE'S OWN: a layer chain deeper than Docker's classic layer store registers (125), which every
# pull of that image on such a store fails the same way, at the first layer past the limit. 1.338.0's standard image was
# 127 layers deep and its arm64 smoke printed the registry verdict below over it; amd64, on the containerd store,
# pulled the same image. Neither a retry nor a fresh store clears it: the image has to lose layers
# (_sandbox/sandbox/src/image/image-layers.integration.test.ts holds the budget).
image_pull_image_fault() {
    grep -Eqi -- 'max depth exceeded' "$1"
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
        if image_pull_image_fault "$log"; then
            rm -f "$log"
            echo "  ✗ could not pull $image — the IMAGE is deeper than Docker's layer store takes (125 layers: max depth exceeded), which no retry, registry or runner clears: the image needs fewer layers" >&2
            return "$status"
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
