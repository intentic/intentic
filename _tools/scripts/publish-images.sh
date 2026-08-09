#!/usr/bin/env bash
# Build + push the first-party intentic images to every registry in REGISTRIES (see below — GHCR):
#   sandbox    the AI-agent workspace daemon + CLI — TWO PROFILES of one Dockerfile (packs/profiles.json):
#              `standard` (core + the standard feature packs, composed by compose-image-dockerfile.mjs) owns
#              the plain tags every runner references; the minimal `core` rides `core-` prefixed tags
#   dind-host  a Docker-in-Docker + sshd deploy-target "host" — connect.ps1 stands one up on Windows so a
#              server-less user can deploy locally (the e2e harness + intentic-local.sh use the same recipe)
# Used by CI — the Images workflow (latest + commit SHA on push to main, one job per arch) and the release
# (release-images.sh: the version + the moving `stable` tag, via semantic-release publishCmd) — and runnable
# by hand:
#   docker login ghcr.io && TAGS=0.1.0 pnpm publish:images
# TAGS is a space-separated tag list; every listed tag is pushed. On release the moving `stable` tag is pushed
# onto the new version; _deploy/state-resolver/src/lib/images.ts and the connect scripts reference `sandbox:stable`
# (unpinned — always the latest release, no digest to maintain). The GHCR packages must be made public once so
# tenant hosts can pull them unauthenticated.
set -euo pipefail
. "$(dirname "$0")/repo-root.sh"

TAGS="${TAGS:?set TAGS (space-separated, e.g. "0.1.0" or "latest sha-abc1234")}"
# Which of the two images to build — the multi-arch flow builds `sandbox` per arch on different runners while
# `dind-host` stays a single amd64 build (it exists for the Windows-local flow; nothing pulls it on arm).
IMAGES="${IMAGES:-sandbox dind-host}"
# Per-arch tag suffix ("-amd64"/"-arm64") for the multi-arch flow: each runner builds its NATIVE arch under
# `<tag><suffix>`, and merge-image-manifests.sh publishes the plain tag as one multi-arch manifest. The
# suffix rides the tags rather than a buildx --platform flag because the payload (`trees`) must be prepared
# natively per arch — pnpm deploy fetches the HOST arch's native prebuilds (sharp, onnxruntime, ast-grep),
# so a cross-built image would carry the wrong ones. Empty = the single-arch flow, plain tags, unchanged.
ARCH_SUFFIX="${ARCH_SUFFIX:-}"
# Space-separated registries, every one of which gets every tag. Adding one is how a second registry would be
# served: the bytes are built once and every listed registry receives the identical manifest.
#
# GHCR PACKAGE VISIBILITY IS SEPARATE FROM REPOSITORY VISIBILITY. A package published from a private repo is
# private, and a private sandbox image means every `curl https://intentic.dev/sync | sh` fails at the pull.
# Each package must be set to public once, by hand, at github.com/orgs/intentic/packages.
REGISTRIES="${REGISTRIES:-ghcr.io/intentic}"
# Monorepo root (_tools/scripts -> up two). The sandbox image's build context is the whole monorepo so
# `pnpm install --frozen-lockfile` resolves the root lockfile; `pnpm deploy` prunes the final image to core.
root="$(repo_root)"

# A docker-container buildx builder. The default `docker` driver exports no cache beyond inline and pushes
# over an untested path here, so this stays — but it is best-effort: a build must NEVER fail over builder setup.
setup_builder() {
    command -v docker >/dev/null || return 0
    docker buildx inspect intentic-cache >/dev/null 2>&1 && { docker buildx use intentic-cache; return 0; }
    # dind serves docker over TLS; the docker-container driver can't read those certs from env vars, only from
    # a named context (that's the "could not create a builder instance with TLS data" error). Build one.
    local ctx=default
    if [ -n "${DOCKER_CERT_PATH:-}" ] && [ -n "${DOCKER_HOST:-}" ]; then
        docker context create intentic-dind \
            --docker "host=${DOCKER_HOST},ca=${DOCKER_CERT_PATH}/ca.pem,cert=${DOCKER_CERT_PATH}/cert.pem,key=${DOCKER_CERT_PATH}/key.pem" >/dev/null 2>&1 || true
        docker context inspect intentic-dind >/dev/null 2>&1 && ctx=intentic-dind
    fi
    docker buildx create --name intentic-cache --driver docker-container --bootstrap --use "$ctx" >/dev/null 2>&1 \
        || echo "  note: docker-container builder unavailable; using the default builder" >&2
}
setup_builder

# Build + push one image under every requested tag. The Dockerfile + build context differ per image: the
# sandbox builds from the monorepo root plus the pre-built `trees` context; the dind-host from its
# self-contained _tools/dind-host package. Extra args after the context pass through to buildx.
#
# The layer cache rides on the image being pushed anyway: `--cache-to type=inline` records the layer cache keys
# in the image config, and the next build reads them back through `--cache-from` on the published tags. Both
# Dockerfiles here are SINGLE-stage — the monorepo is compiled OUTSIDE Docker by prepare-image-trees.sh and
# enters as the `trees` context — so the pushed image already contains every layer worth caching, and inline
# covers the identical layer set a separate mode=max ref would.
#
# It covers that set far more reliably. A separate `type=registry,ref=…:buildcache` meant a SECOND ~1.5 GB
# upload, and a registry that answers the finalizing PUT of its largest blob with a 400 makes buildkit
# cancel the image push running alongside it, so a fully-pushed image got thrown away — that is how 1.159.0
# and 1.160.0 reached npm with no sandbox image behind them. ignore-error=true stopped that from failing the
# build, and thereby made it SILENT: sandbox:buildcache froze at 2026-07-23 and nothing said so for eight days,
# during which every sandbox build ran fully cold (~20 min, in both the images and release jobs, every
# pipeline). Inline has no second upload to fail — if the image pushed, the cache is fresh.
# TAG_PREFIX distinguishes the sandbox PROFILES on one GHCR package: the standard image owns the plain tags
# (`latest`, `stable`, versions — everything that referenced sandbox:stable keeps meaning the batteries-included
# image), the core image the `core-` prefixed ones. Cache reads cover both prefixes: the core layer set is a
# strict prefix of the standard one, so whichever profile pushed last is a warm parent for either build.
publish() {
    local image="$1" dockerfile="$2" context="$3"
    shift 3
    # One build, every registry: buildx pushes each -t it was given, so the bytes are built once and every
    # registry receives the identical manifest rather than independent builds that could drift.
    local tag_args=() cache_args=()
    local registry prefix
    for registry in $REGISTRIES; do
        for tag in $TAGS; do
            tag_args+=(-t "$registry/$image:${TAG_PREFIX:-}$tag$ARCH_SUFFIX")
        done
        # `latest` moves on every main push that touches the core, `stable` on every release; whichever is
        # newer is a warm parent, and the release job (which pushes neither) reads both. A missing or
        # unreachable ref is a non-fatal warning, so this is correct against a cold registry too — which is
        # exactly what GHCR is on the first run. Under a suffix the per-arch tags are the true parents (the
        # plain tag is a manifest list whose amd64 half also warms an amd64 build, so it stays in the list).
        for prefix in "" "core-"; do
            cache_args+=(--cache-from "type=registry,ref=$registry/$image:${prefix}latest$ARCH_SUFFIX")
            cache_args+=(--cache-from "type=registry,ref=$registry/$image:${prefix}stable$ARCH_SUFFIX")
            if [ -n "$ARCH_SUFFIX" ]; then
                cache_args+=(--cache-from "type=registry,ref=$registry/$image:${prefix}latest")
                cache_args+=(--cache-from "type=registry,ref=$registry/$image:${prefix}stable")
            fi
        done
    done
    docker buildx build -f "$dockerfile" "${tag_args[@]}" "${cache_args[@]}" \
        --cache-to "type=inline" \
        "$@" --push "$context"
}

case " $IMAGES " in
    *" sandbox "*)
        # The sandbox image COPYs its compiled payload from .image-out — prepare-image-trees.sh must have run first.
        [ -d "$root/.image-out/sandbox" ] || { echo "missing $root/.image-out — run _tools/scripts/prepare-image-trees.sh first" >&2; exit 1; }
        # Two profiles of one Dockerfile (see packs/profiles.json): `standard` — the core file with the
        # standard feature packs spliced in — owns the plain tags every runner references; the bare core file
        # is the minimal image under `core-` prefixed tags. Composed fresh here so the published bytes always
        # come from the checked-in pack files.
        node "$root/_tools/scripts/compose-image-dockerfile.mjs" standard > "$root/.image-out/Dockerfile.standard"
        publish sandbox "$root/.image-out/Dockerfile.standard" "$root" --build-context "trees=$root/.image-out"
        TAG_PREFIX="core-" publish sandbox "$root/_sandbox/sandbox/Dockerfile" "$root" --build-context "trees=$root/.image-out"
        ;;
esac
case " $IMAGES " in
    *" dind-host "*) publish dind-host "$root/_tools/dind-host/Dockerfile" "$root/_tools/dind-host" ;;
esac
