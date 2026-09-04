#!/usr/bin/env bash
# Build + push the first-party intentic images to every registry in REGISTRIES (see below — GHCR):
#   sandbox    the AI-agent workspace daemon + CLI — TWO PROFILES of one Dockerfile (packs/profiles.json):
#              `standard` (core + the standard feature packs, composed by compose-image-dockerfile.mjs) owns
#              the plain tags every runner references; the minimal `core` rides `core-` prefixed tags
#   dind-host  a Docker-in-Docker + sshd deploy-target "host" — connect.ps1 stands one up on Windows so a
#              server-less user can deploy locally (the e2e harness uses the same recipe, from _tools/dind-host)
# Used by CI — the Images workflow (latest + commit SHA on push to main, one job per arch) and the release
# (release-images.sh: the version + the moving `stable` tag, via semantic-release publishCmd) — and runnable
# by hand:
#   docker login ghcr.io && TAGS=0.1.0 pnpm publish:images
# TAGS is a space-separated tag list; every listed tag is pushed. On release the moving `stable` tag — the one
# every connect script and _deploy/state-resolver/src/lib/images.ts reference — is pushed onto the new version
# as part of that same publish, so a green pipeline IS the ship (COMPATIBILITY.md). Unpinned: no digest to
# maintain. The GHCR packages must be made public once so tenant hosts can pull them unauthenticated.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"
# GHCR refuses a burst of manifest PUTs with a 403 that is a clock, not a permissions problem — one pipeline
# writes this image six times. registry-retry.sh says the rest; every push below goes through it.
. "$(dirname "$0")/../lib/registry-retry.sh"

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

# How long BuildKit state may sit unused in the builder below before a build sweeps it. A BOUND on a store that
# otherwise grows for the life of the runner host, not a tuning knob — see setup_builder.
BUILDKIT_CACHE_MAX_AGE="${BUILDKIT_CACHE_MAX_AGE:-72h}"

# A docker-container buildx builder. The default `docker` driver exports no cache beyond inline and pushes
# over an untested path here, so this stays — but it is best-effort: a build must NEVER fail over builder setup.
#
# AND ITS CACHE IS THE ONE STORE ON THESE RUNNERS THAT NOTHING EVICTED. Every other shared directory has an
# owner in docs/ci-runner.md's "Keeping it bounded": turbo gets a 14-day sweep in the pnpm-setup action, pnpm
# and cargo grow only when a version is added, xwin and playwright are fixed-size downloads. This one is a
# `docker-container` driver, so its BuildKit state is a docker VOLUME on the host daemon rather than anything
# under /ci-cache — outside every sweep that file describes, and outside a `docker system prune` that spares
# volumes. It grew until the host ran out: on 30 August the runner box had 2.04 GB free of 1 TB with
# docker_data.vhdx at 456 GB, and a docker whose data disk cannot extend stops ANSWERING rather than erroring.
# Six pipelines in a row then hung in "Initialize containers" and were killed at their own timeout-minutes,
# which Actions reports as `cancelled` — with all six listeners still online, so nothing looked down.
#
# SWEPT BY AGE, like the turbo cache it sits beside, and cheap here in a way it would not be elsewhere: this
# builder's local state is not the cache of record. `--cache-to type=inline` writes the layer cache into the
# image being pushed and the next build reads it back over `--cache-from type=registry` (see publish() below),
# so a swept builder costs a registry read, not a cold build.
setup_builder() {
    command -v docker >/dev/null || return 0
    if ! docker buildx inspect intentic-cache >/dev/null 2>&1; then
        # dind serves docker over TLS; the docker-container driver can't read those certs from env vars, only
        # from a named context (that's the "could not create a builder instance with TLS data" error). Build one.
        local ctx=default
        if [ -n "${DOCKER_CERT_PATH:-}" ] && [ -n "${DOCKER_HOST:-}" ]; then
            docker context create intentic-dind \
                --docker "host=${DOCKER_HOST},ca=${DOCKER_CERT_PATH}/ca.pem,cert=${DOCKER_CERT_PATH}/cert.pem,key=${DOCKER_CERT_PATH}/key.pem" >/dev/null 2>&1 || true
            docker context inspect intentic-dind >/dev/null 2>&1 && ctx=intentic-dind
        fi
        docker buildx create --name intentic-cache --driver docker-container --bootstrap --use "$ctx" >/dev/null 2>&1 \
            || echo "  note: docker-container builder unavailable; using the default builder" >&2
    fi
    docker buildx use intentic-cache >/dev/null 2>&1 || true
    # AFTER the `use`, so it always sweeps the builder that is about to run the build — including the default
    # one, on a host where the create above failed. `until` is the one prune filter whose spelling has not moved
    # across buildx versions; the byte-capped flags have been renamed twice, and a build must never fail here.
    docker buildx prune -f --filter "until=$BUILDKIT_CACHE_MAX_AGE" >/dev/null 2>&1 || true
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
    registry_retry docker buildx build -f "$dockerfile" "${tag_args[@]}" "${cache_args[@]}" \
        --cache-to "type=inline" \
        "$@" --push "$context"
}

case " $IMAGES " in
    *" sandbox "*)
        # The sandbox image COPYs its compiled payload from .image-out — prepare-image-trees.sh must have run first.
        [ -d "$root/.image-out/sandbox" ] || { echo "missing $root/.image-out — run _tools/scripts/image/prepare-image-trees.sh first" >&2; exit 1; }
        # Two profiles of one Dockerfile (see packs/profiles.json): `standard` — the core file with the
        # standard feature packs spliced in — owns the plain tags every runner references; the bare core file
        # is the minimal image under `core-` prefixed tags. Composed fresh here so the published bytes always
        # come from the checked-in pack files.
        node "$root/_tools/scripts/image/compose-image-dockerfile.mjs" standard > "$root/.image-out/Dockerfile.standard"
        publish sandbox "$root/.image-out/Dockerfile.standard" "$root" --build-context "trees=$root/.image-out"
        TAG_PREFIX="core-" publish sandbox "$root/_sandbox/sandbox/Dockerfile" "$root" --build-context "trees=$root/.image-out"
        ;;
esac
case " $IMAGES " in
    *" dind-host "*) publish dind-host "$root/_tools/dind-host/Dockerfile" "$root/_tools/dind-host" ;;
esac
