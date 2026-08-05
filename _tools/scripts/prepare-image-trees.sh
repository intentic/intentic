#!/usr/bin/env bash
# Build the sandbox image's payload OUTSIDE Docker: compile the six baked packages with turbo (warm cache —
# in CI this replays release:verify's work instead of re-compiling the monorepo inside a cacheless container),
# prune each to a production tree under .image-out/, and fetch the iq models once (.image-out/iq-models is
# CI-cached keyed on the fetch script, and survives re-runs here). The Dockerfile consumes .image-out as the
# named build context `trees`, so its own layers are pure COPYs.
#   bash _tools/scripts/prepare-image-trees.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

pnpm turbo run build --filter=@intentic/sandbox --filter=@intentic/cli --filter=@intentic/iq \
    --filter=@intentic/ext-discord --filter=@intentic/ext-imap --filter=@intentic/ext-slack

out=.image-out
# Regenerate the deploy trees but PRESERVE the cached model dir (and its completeness marker).
rm -rf "$out/sandbox" "$out/cli" "$out/iq" "$out/extensions"
# Six independent trees, each pruned out of the same content-addressed store into a directory of its own —
# which is what a store is for, so they are pruned at once rather than one after another (1m26s in series,
# measured in the images job of pipeline 2725042409, and paid again by the release).
# @intentic/lsp is NOT a tree of its own: it is a dependency of @intentic/sandbox, so turbo builds it under that
# filter (build dependsOn ^build) and the sandbox's deploy carries it — the image symlinks `lsp` straight out of
# /opt/sandbox rather than shipping a 54 MiB second copy of the same package.
pids=()
deploy() {
    pnpm --filter "$1" deploy --prod "$2" &
    pids+=("$!")
}
deploy @intentic/sandbox "$out/sandbox"
deploy @intentic/cli "$out/cli"
deploy @intentic/iq "$out/iq"
deploy @intentic/ext-discord "$out/extensions/discord"
deploy @intentic/ext-imap "$out/extensions/imap"
deploy @intentic/ext-slack "$out/extensions/slack"

failed=0
for pid in "${pids[@]}"; do
    wait "$pid" || failed=1
done
[ "$failed" -eq 0 ] || { echo "one or more deploy trees failed to build" >&2; exit 1; }

# The Dockerfile bakes Chromium from a layer that sits ABOVE the tree COPYs (so a source change can't evict a
# ~180 MiB download), which means it cannot read the deployed tree's playwright to decide what to install.
# Hand it the version instead: a playwright version pins its chromium revision, so installing the SAME version
# yields the same revision — the one the daemon's chromium.executablePath() resolves at runtime. Emitted from
# the deployed tree rather than package.json so it is the resolved version, catalog indirection included.
node -p "require('./$out/sandbox/node_modules/playwright/package.json').version" > "$out/playwright-version"

# The baked embedding + reranker models (~57MB from HF). The marker sits OUTSIDE the model dir so the tree
# COPY'd into the image stays exactly the layout fetch-model.mjs validated.
if [ ! -f "$out/.iq-models-complete" ]; then
    rm -rf "$out/iq-models"
    node _search/iq-engine/scripts/fetch-model.mjs "$out/iq-models"
    touch "$out/.iq-models-complete"
fi
echo "image trees ready in $out/"
