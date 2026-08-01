#!/usr/bin/env bash
# Build the sandbox image's payload OUTSIDE Docker: compile the seven baked packages with turbo (warm cache —
# in CI this replays release:verify's work instead of re-compiling the monorepo inside a cacheless container),
# prune each to a production tree under .image-out/, and fetch the iq models once (.image-out/iq-models is
# CI-cached keyed on the fetch script, and survives re-runs here). The Dockerfile consumes .image-out as the
# named build context `trees`, so its own layers are pure COPYs.
#   bash _tools/scripts/prepare-image-trees.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

pnpm turbo run build --filter=@intentic/sandbox --filter=@intentic/cli --filter=@intentic/iq \
    --filter=@intentic/lsp --filter=@intentic/ext-discord --filter=@intentic/ext-imap --filter=@intentic/ext-slack

out=.image-out
# Regenerate the deploy trees but PRESERVE the cached model dir (and its completeness marker).
rm -rf "$out/sandbox" "$out/cli" "$out/iq" "$out/lsp" "$out/extensions"
pnpm --filter @intentic/sandbox deploy --prod "$out/sandbox"
pnpm --filter @intentic/cli deploy --prod "$out/cli"
pnpm --filter @intentic/iq deploy --prod "$out/iq"
pnpm --filter @intentic/lsp deploy --prod "$out/lsp"
pnpm --filter @intentic/ext-discord deploy --prod "$out/extensions/discord"
pnpm --filter @intentic/ext-imap deploy --prod "$out/extensions/imap"
pnpm --filter @intentic/ext-slack deploy --prod "$out/extensions/slack"

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
    node _libs/iq-engine/scripts/fetch-model.mjs "$out/iq-models"
    touch "$out/.iq-models-complete"
fi
echo "image trees ready in $out/"
