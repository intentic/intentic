#!/usr/bin/env bash
# Build the sandbox image's payload OUTSIDE Docker: compile the baked packages with turbo (warm cache —
# in CI this replays release:verify's work instead of re-compiling the monorepo inside a cacheless container),
# prune each to a production tree under .image-out/, and fetch the iq models once (.image-out/iq-models is
# CI-cached keyed on the fetch script, and survives re-runs here). The Dockerfile consumes .image-out as the
# named build context `trees`, so its own layers are pure COPYs.
#   bash _tools/scripts/image/prepare-image-trees.sh
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
. "$(dirname "$0")/../lib/docker-config.sh"
cd "$(repo_root)"
# The starter build below is a docker build, as netd's is: the same fix for a credential helper this shell cannot run.
docker_config_without_missing_helpers

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
# @intentic/lsp, @intentic/iq and @intentic/ocr are NOT here: all are dependencies of @intentic/sandbox, so turbo
# builds them under its filter (build dependsOn ^build) and the sandbox's deploy carries them — the image symlinks
# `lsp`, `iq` and `ocr` straight out of /opt/sandbox rather than shipping second copies of the same packages (a
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
@intentic/ext-microsoft-365:$out/extensions/microsoft-365
@intentic/ext-prawo:$out/extensions/prawo
"
# The extensions whose dist the image needs: onlyoffice's backend bundle (dist/server.js, the manifest's `server`) and
# the browser engine's editor page it serves (dist/editor/editor.js),
# which the daemon's extension host runs in every sandbox. The feature backends (deployments, knowledge) are not
# here: they moved to their own repositories and install from the registry. e-urzad's backend (dist/server.js) and its
# agent CLI (dist/cli.js, which bin/e-urzad runs) are vite bundles too, so its dist is all it needs beside the files the
# Dockerfile copies from the repository. The copy loop below carries each entry.
BUNDLES="onlyoffice e-urzad"

filters=()
for entry in $TREES; do filters+=(--filter="${entry%%:*}"); done
for ext in $BUNDLES; do filters+=(--filter="@intentic/ext-$ext"); done
pnpm turbo run build "${filters[@]}"

# Regenerate the deploy trees but PRESERVE the cached model dir (and its completeness marker).
rm -rf "$out/sandbox" "$out/cli" "$out/extensions" "$out/layers"
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

# Which source the daemon was built from, for its /health and startup line (src/system/boot/build-info.ts): every
# working-tree build is version 0.0.0, so the commit is what tells whether a fix is live. A checkout with uncommitted
# changes says so, since its commit alone would claim code it does not hold.
commit="$(git rev-parse HEAD 2>/dev/null || true)"
if [ -n "$commit" ] && ! git diff --quiet HEAD 2>/dev/null; then commit="$commit-dirty"; fi
printf '{"commit":"%s","builtAt":"%s"}\n' "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$out/sandbox/build-info.json"

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
# global-installs the same pinned version onto PATH (image-packs/codex.Dockerfile; packs.integration.test.ts holds the
# pins in step), and the adapter directly spawns that binary's app-server surface. Shipping it in the tree too
# would put the one copy the pack owns back into every image, core included.
# The -xtype l pass clears the symlinks both prunes leave dangling in dependents' node_modules (never
# followed, but no reason to ship them).
# @cursor/sdk is the daemon's Cursor runtime, and the one dependency here pruned for a LICENCE reason rather
# than a size one: "all rights reserved, use subject to Cursor's Terms of Service" grants no redistribution, and
# a published image containing it would redistribute it to everyone who pulls that image, Cursor account or not.
# It is a repo dependency so the daemon type-checks against it and a dev run works; image-packs/cursor.Dockerfile
# installs the same pin into /opt/cursor-sdk on the OWNER's own machine. The explicit Connect action bootstraps
# that install for login; the resulting credential then keeps it in the durable overlay. cursor/cursor-sdk.ts
# loads it dynamically so a tree without it still boots. Its ~15 MiB per-platform packages go with it — nothing
# left behind can resolve them.
rm -rf "$out"/sandbox/node_modules/.pnpm/onnxruntime-web@*
rm -rf "$out"/sandbox/node_modules/.pnpm/@openai+codex@*
rm -rf "$out"/sandbox/node_modules/.pnpm/@cursor+sdk@*
rm -rf "$out"/sandbox/node_modules/.pnpm/@cursor+sdk-*
find "$out/sandbox/node_modules" -xtype l -delete

# onnxruntime-node ships its native binding for EVERY OS and CPU in one package (bin/napi-v*/<os>/<cpu>), and pnpm
# has no say in it: measured in 1.344.0, darwin/arm64 86 MiB, win32/arm64 70, win32/x64 64 and the other linux CPU
# 25, so ~245 MiB of every image could never load. The binding resolves bin/napi-v*/<process.platform>/<process.arch>,
# and this tree is already this machine's CPU only (its sharp, sherpa-onnx and claude-agent-sdk platform packages are
# pnpm's pick for the host), so the host's arch is the one to keep, exactly as for those.
arch="$(node -p process.arch)"
for bin in "$out"/sandbox/node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*; do
    [ -d "$bin/linux/$arch" ] || { echo "$bin has no linux/$arch binding to keep" >&2; exit 1; }
    for platform in "$bin"/*/*; do
        [ "$platform" = "$bin/linux/$arch" ] || rm -rf "$platform"
    done
    rmdir "$bin"/* 2>/dev/null || true
done

# The daemon's own TypeScript source and its tests: 29 MiB of every image (12 of it tests) that nothing at run time
# reads. The daemon runs dist/, and the `@intentic/src` export condition that points at source is a build-tool
# condition the image's node never sets.
rm -rf "$out/sandbox/src"

# THE EXTENSION TREES SHARE THE DAEMON'S PACKAGES. Each gateway is its own `pnpm deploy`, so each carried its own copy of
# what the daemon's tree already holds: 15 MiB of @intentic/sandbox-contract apiece, zod, and the rest. A package
# directory that is byte-for-byte the daemon's (same name in pnpm's store, which names the exact version and peers,
# and the same content, symlinks included) becomes a link to the daemon's copy. Node resolves through the link's real
# path, so its dependencies come from the daemon's tree, the same versions under the same names. Relative, so it
# resolves the same in .image-out and in the image (/opt/extensions/<ext> beside /opt/sandbox). Done before the
# daemon's third-party packages move out of $out/sandbox below, so every candidate is still there to compare.
for store in "$out"/extensions/*/node_modules/.pnpm; do
    [ -d "$store" ] || continue
    for dir in "$store"/*; do
        name="${dir##*/}"
        shared="$out/sandbox/node_modules/.pnpm/$name"
        case "$name" in node_modules | lock.yaml) continue ;; esac
        if [ ! -L "$dir" ] && [ -d "$shared" ] && diff -rq --no-dereference "$dir" "$shared" >/dev/null 2>&1; then
            rm -rf "$dir"
            ln -s "../../../../sandbox/node_modules/.pnpm/$name" "$dir"
        fi
    done
done

# STATIC LAYER ROOTS: what the image copies with `COPY --link --from=trees layers/<name>/ /`, so a layer whose bytes did
# not change keeps its digest and an update does not download it again. Two things decide that digest besides the
# content, and both used to change from build to build: each file's mtime (when this runner happened to fetch or
# deploy it) and the parent directories a COPY creates (`opt/`, stamped with the build's own clock). Measured between
# 1.342.0 and 1.344.0: the speech and iq model layers held identical files and still got new digests (speech on both
# counts, iq on `opt/` alone), ~504 MB of the ~1 GB compressed an update downloaded. So each root carries its whole path from / down, every entry at one fixed time, and --link builds the
# layer apart from whatever sits under it. The image's Dockerfile splices these ABOVE the trees that change per commit,
# because Docker's classic store re-downloads every layer above the first changed one whatever its digest.
normalize_times() { find "$1" -exec env TZ=UTC touch -h -t 198001010000.00 {} +; }
static_layer() { # <layer name> <directory to carry> <its path in the image>
    local root="$out/layers/$1"
    mkdir -p "$root$(dirname "$3")"
    # Hard links where the filesystem allows them: the model dirs are hundreds of MiB, and the cached original is
    # what the next run reuses (only its mtimes change, which nothing reads).
    if ! cp -al "$2" "$root$3" 2>/dev/null; then
        rm -rf "$root$3"
        cp -R "$2" "$root$3"
    fi
    normalize_times "$root"
}

# The daemon's third-party node_modules: ~950 MiB of its ~1.1 GiB tree, and identical on every release whose lockfile
# moved nothing the daemon depends on (about half of them). The workspace's own packages (`@intentic+…`, and anything
# whose name carries a `file:`/`link:` path) change on every commit and stay in the tree COPY'd after it, together with
# .pnpm/node_modules and lock.yaml, which list them.
deps="$out/layers/sandbox-deps/opt/sandbox/node_modules/.pnpm"
mkdir -p "$deps"
for dir in "$out"/sandbox/node_modules/.pnpm/*; do
    case "${dir##*/}" in
        node_modules | lock.yaml | @intentic+* | *@file+* | *@link+*) ;;
        *) mv "$dir" "$deps/" ;;
    esac
done
normalize_times "$out/layers/sandbox-deps"

# The same split for the extension trees (the messaging pack's gateways): the third-party packages left after the
# dedupe above go to one static layer root, the per-commit rest stays in each tree.
for store in "$out"/extensions/*/node_modules/.pnpm; do
    [ -d "$store" ] || continue
    ext="${store%/node_modules/.pnpm}"
    ext="${ext##*/}"
    target="$out/layers/messaging-deps/opt/extensions/$ext/node_modules/.pnpm"
    mkdir -p "$target"
    for dir in "$store"/*; do
        case "${dir##*/}" in
            node_modules | lock.yaml | @intentic+* | *@file+* | *@link+*) ;;
            *) [ -L "$dir" ] || mv "$dir" "$target/" ;;
        esac
    done
done
mkdir -p "$out/layers/messaging-deps"
normalize_times "$out/layers/messaging-deps"

# netd the entrypoint execs (_sandbox/netd), compiled in the image's own Debian release: the one piece of the
# payload no JS build produces, and whose glibc must be the image's rather than this machine's.
bash _tools/scripts/image/build-netd.sh "$out/netd"

# The baked embedding + reranker models (~57MB from HF). The marker sits OUTSIDE the model dir so the tree
# COPY'd into the image stays exactly the layout fetch-model.mjs validated.
if [ ! -f "$out/.iq-models-complete" ]; then
    rm -rf "$out/iq-models"
    node _search/iq-engine/scripts/fetch-model.mjs "$out/iq-models"
    touch "$out/.iq-models-complete"
fi

# The baked dictation model (~640 MiB, image-packs/speech.Dockerfile), fetched at the revision and digests the
# speech package pins. The script skips a file already there at its digest, so a reused trees context fetches nothing.
if [ ! -f "$out/.speech-models-complete" ]; then
    node _sandbox/speech/scripts/fetch-speech-models.mjs "$out/speech-models" parakeet
    touch "$out/.speech-models-complete"
fi
static_layer iq-models "$out/iq-models" /opt/iq-models
static_layer speech-models "$out/speech-models" /opt/speech-models

# The starter site a new sandbox opens on, scaffolded by this commit's CLI and installed (_sandbox/sandbox/starter/
# starter.Dockerfile, which says why it is built here and not in the image). Its output is already a layer root with
# pnpm's clocks taken out; intentic's own first page goes over the template's (starter-site/ replaces src/ and public/
# only, never the package or its install), and then every timestamp is fixed like the other static layers.
# STARTER_TEMPLATE_REF picks the template's branch or tag, main by default.
# It also hands back pnpm's metadata for the `pnpm` package, which the seeded starter's first `pnpm` resolves its pinned
# pnpm through (starter.Dockerfile says why it is kept apart); that tree is copied among the per-commit layers.
starter_build="$out/layers/.starter-build"
docker buildx build --file _sandbox/sandbox/starter/starter.Dockerfile --build-context cli="$out/cli" \
    --build-arg STARTER_TEMPLATE_REF="${STARTER_TEMPLATE_REF:-main}" \
    --output "type=local,dest=$starter_build" _sandbox/sandbox/starter
[ -f "$starter_build/starter/opt/starter/node_modules/.modules.yaml" ] || { echo "the starter build produced no installed starter" >&2; exit 1; }
mv "$starter_build/starter" "$out/layers/starter"
mv "$starter_build/pnpm-metadata" "$out/layers/pnpm-metadata"
rmdir "$starter_build"
cp -R _sandbox/sandbox/starter-site/. "$out/layers/starter/opt/starter/_apps/landing/"
normalize_times "$out/layers/starter"
echo "image trees ready in $out/"
