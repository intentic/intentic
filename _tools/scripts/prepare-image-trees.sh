#!/usr/bin/env bash
# Build the sandbox image's payload OUTSIDE Docker: compile the seven baked packages with turbo (warm cache —
# in CI this replays release:verify's work instead of re-compiling the monorepo inside a cacheless container),
# prune each to a production tree under .image-out/, and fetch the iq models once (.image-out/iq-models is
# CI-cached keyed on the fetch script, and survives re-runs here). The Dockerfile consumes .image-out as the
# named build context `trees`, so its own layers are pure COPYs.
#   bash _tools/scripts/prepare-image-trees.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

# ext-memory and ext-deployments build their BACKEND bundles (dist/server.js) here — the Dockerfile COPYs
# them from the repo tree beside the manifest (no deploy tree: the bundles are self-contained, so shipping
# node_modules would be waste).
pnpm turbo run build --filter=@intentic/sandbox --filter=@intentic/cli \
    --filter=@intentic/ext-discord --filter=@intentic/ext-imap --filter=@intentic/ext-slack --filter=@intentic/ext-telegram --filter=@intentic/ext-whatsapp \
    --filter=@intentic/ext-memory --filter=@intentic/ext-deployments

out=.image-out
# Regenerate the deploy trees but PRESERVE the cached model dir (and its completeness marker).
rm -rf "$out/sandbox" "$out/cli" "$out/extensions"
# Seven independent trees, each pruned out of the same content-addressed store into a directory of its own —
# which is what a store is for, so they are pruned at once rather than one after another (1m26s in series,
# measured in the images job of pipeline 2725042409, and paid again by the release).
# @intentic/lsp and @intentic/iq are NOT trees of their own: both are dependencies of @intentic/sandbox, so
# turbo builds them under that filter (build dependsOn ^build) and the sandbox's deploy carries them — the image
# symlinks `lsp` and `iq` straight out of /opt/sandbox rather than shipping second copies of the same packages
# (a deployed iq tree duplicated ~450 MiB of the daemon's node_modules for a CLI whose own code is <1 MiB).
pids=()
deploy() {
    pnpm --filter "$1" deploy --prod "$2" &
    pids+=("$!")
}
deploy @intentic/sandbox "$out/sandbox"
deploy @intentic/cli "$out/cli"
deploy @intentic/ext-discord "$out/extensions/discord"
deploy @intentic/ext-imap "$out/extensions/imap"
deploy @intentic/ext-slack "$out/extensions/slack"
deploy @intentic/ext-telegram "$out/extensions/telegram"
deploy @intentic/ext-whatsapp "$out/extensions/whatsapp"

failed=0
for pid in "${pids[@]}"; do
    wait "$pid" || failed=1
done
[ "$failed" -eq 0 ] || { echo "one or more deploy trees failed to build" >&2; exit 1; }

# onnxruntime-web is @huggingface/transformers' BROWSER backend (WebAssembly/WebGPU) — ~129 MiB that can never
# load in the image: the node dist the daemon and iq resolve (dist/transformers.node.{mjs,cjs}) requires only
# onnxruntime-node + onnxruntime-common, and nothing else in dist/ resolves the web package. pnpm deploy has no
# per-dependency exclude, so it is pruned from the tree after the fact.
# @openai/codex is the ~350 MiB platform binary @openai/codex-sdk exact-pins — only ever needed at SPAWN time,
# and the codex feature pack global-installs the same pinned version onto PATH (packs/codex.Dockerfile;
# packs.integration.test.ts holds the pins in step), which the adapter drives via codexPathOverride. Shipping it in the
# tree too would put the one copy the pack owns back into every image, core included.
# The -xtype l pass clears the symlinks both prunes leave dangling in dependents' node_modules (never
# followed, but no reason to ship them).
rm -rf "$out"/sandbox/node_modules/.pnpm/onnxruntime-web@*
rm -rf "$out"/sandbox/node_modules/.pnpm/@openai+codex@*
find "$out/sandbox/node_modules" -xtype l -delete

# The baked embedding + reranker models (~57MB from HF). The marker sits OUTSIDE the model dir so the tree
# COPY'd into the image stays exactly the layout fetch-model.mjs validated.
if [ ! -f "$out/.iq-models-complete" ]; then
    rm -rf "$out/iq-models"
    node _search/iq-engine/scripts/fetch-model.mjs "$out/iq-models"
    touch "$out/.iq-models-complete"
fi
echo "image trees ready in $out/"
