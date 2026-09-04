#!/usr/bin/env bash
# Build the sandbox image's payload OUTSIDE Docker: compile the baked packages with turbo (warm cache —
# in CI this replays release:verify's work instead of re-compiling the monorepo inside a cacheless container),
# prune each to a production tree under .image-out/, and fetch the iq models once (.image-out/iq-models is
# CI-cached keyed on the fetch script, and survives re-runs here). The Dockerfile consumes .image-out as the
# named build context `trees`, so its own layers are pure COPYs.
#   bash _tools/scripts/image/prepare-image-trees.sh
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
cd "$(repo_root)"

out=.image-out

# EVERYTHING THE PAYLOAD IS MADE OF, WRITTEN DOWN ONCE. Two kinds, and the difference is only what the image
# takes from them: a TREE is pruned to production and copied whole, a BUNDLE is a self-contained dist/ the
# image copies on its own (no node_modules to deploy, so no tree). Both have to be COMPILED first, and the
# turbo filter below is derived from these two lists rather than kept as a third one beside them.
#
# It was a third list, and both times an extension joined the payload the filter was the line that was missed.
# It stayed invisible because the fleet's runners check out with `clean: false`: a dist left behind by the
# previous pipeline sat in the tree, and the build that never ran was never missed. A FRESH checkout is where
# it surfaces — the arm64 halves run on hosted runners, and that is where knowledge's bundle came up absent.
# For a tree it does not even fail: the deploy quietly ships a package with no dist and the image is broken
# where nothing looks.
#
# @intentic/lsp and @intentic/iq are NOT here: both are dependencies of @intentic/sandbox, so turbo builds
# them under its filter (build dependsOn ^build) and the sandbox's deploy carries them — the image symlinks
# `lsp` and `iq` straight out of /opt/sandbox rather than shipping second copies of the same packages (a
# deployed iq tree duplicated ~450 MiB of the daemon's node_modules for a CLI whose own code is <1 MiB).
TREES="
@intentic/sandbox:$out/sandbox
@intentic/cli:$out/cli
@intentic/ext-discord:$out/extensions/discord
@intentic/ext-imap:$out/extensions/imap
@intentic/ext-slack:$out/extensions/slack
@intentic/ext-telegram:$out/extensions/telegram
@intentic/ext-whatsapp:$out/extensions/whatsapp
@intentic/ext-google-workspace:$out/extensions/google-workspace
"
# The extensions whose dist the image needs: the feature backend the daemon's backend host loads (manifest
# `server`), and knowledge, which ships both a backend and the `kb` CLI built from the same TypeScript so the
# agent and the panel cannot disagree about what the vault says.
BUNDLES="deployments knowledge"

filters=()
for entry in $TREES; do filters+=(--filter="${entry%%:*}"); done
for ext in $BUNDLES; do filters+=(--filter="@intentic/ext-$ext"); done
pnpm turbo run build "${filters[@]}"

# Regenerate the deploy trees but PRESERVE the cached model dir (and its completeness marker).
rm -rf "$out/sandbox" "$out/cli" "$out/extensions"
# Each tree pruned out of the same content-addressed store into a directory of its own — which is what a store
# is for, so they are pruned at once rather than one after another (1m26s in series, measured in the images job
# of pipeline 2725042409, and paid again by the release).
pids=()
for entry in $TREES; do
    pnpm --filter "${entry%%:*}" deploy --prod "${entry#*:}" &
    pids+=("$!")
done

failed=0
for pid in "${pids[@]}"; do
    wait "$pid" || failed=1
done
[ "$failed" -eq 0 ] || { echo "one or more deploy trees failed to build" >&2; exit 1; }

# The bundles. They are COMPILED OUTPUT, and compiled output reaches the image only through this context: the
# root build context excludes **/dist (.dockerignore, since the first commit), so a COPY of these straight from
# the repo tree resolves to nothing — docker fails the build with "not found" on a path that is sitting right
# there in the checkout, which is exactly how this shipped broken.
for ext in $BUNDLES; do
    src="_extensions/$ext/dist"
    [ -d "$src" ] || { echo "$src is missing — the turbo build above did not produce ext-$ext's bundle" >&2; exit 1; }
    mkdir -p "$out/extensions/$ext"
    cp -R "$src" "$out/extensions/$ext/dist"
done

# onnxruntime-web is @huggingface/transformers' BROWSER backend (WebAssembly/WebGPU) — ~129 MiB that can never
# load in the image: the node dist the daemon and iq resolve (dist/transformers.node.{mjs,cjs}) requires only
# onnxruntime-node + onnxruntime-common, and nothing else in dist/ resolves the web package. pnpm deploy has no
# per-dependency exclude, so it is pruned from the tree after the fact.
# @openai/codex is the ~350 MiB platform binary @openai/codex-sdk exact-pins. The codex feature pack
# global-installs the same pinned version onto PATH (packs/codex.Dockerfile; packs.integration.test.ts holds the
# pins in step), and the adapter directly spawns that binary's app-server surface. Shipping it in the tree too
# would put the one copy the pack owns back into every image, core included.
# The -xtype l pass clears the symlinks both prunes leave dangling in dependents' node_modules (never
# followed, but no reason to ship them).
# @cursor/sdk is the daemon's Cursor runtime, and the one dependency here pruned for a LICENCE reason rather
# than a size one: "all rights reserved, use subject to Cursor's Terms of Service" grants no redistribution, and
# a published image containing it would redistribute it to everyone who pulls that image, Cursor account or not.
# It is a repo dependency so the daemon type-checks against it and a dev run works; packs/cursor.Dockerfile
# installs the same pin into /opt/cursor-sdk on the OWNER's own machine. The explicit Connect action bootstraps
# that install for login; the resulting credential then keeps it in the durable overlay. cursor/cursor-sdk.ts
# loads it dynamically so a tree without it still boots. Its ~15 MiB per-platform packages go with it — nothing
# left behind can resolve them.
rm -rf "$out"/sandbox/node_modules/.pnpm/onnxruntime-web@*
rm -rf "$out"/sandbox/node_modules/.pnpm/@openai+codex@*
rm -rf "$out"/sandbox/node_modules/.pnpm/@cursor+sdk@*
rm -rf "$out"/sandbox/node_modules/.pnpm/@cursor+sdk-*
find "$out/sandbox/node_modules" -xtype l -delete

# The baked embedding + reranker models (~57MB from HF). The marker sits OUTSIDE the model dir so the tree
# COPY'd into the image stays exactly the layout fetch-model.mjs validated.
if [ ! -f "$out/.iq-models-complete" ]; then
    rm -rf "$out/iq-models"
    node _search/iq-engine/scripts/fetch-model.mjs "$out/iq-models"
    touch "$out/.iq-models-complete"
fi
echo "image trees ready in $out/"
