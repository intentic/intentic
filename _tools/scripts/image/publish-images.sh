#!/usr/bin/env bash
# Build + push the first-party intentic images to every registry in REGISTRIES (see below — GHCR):
#   sandbox    the AI-agent workspace daemon + CLI — TWO PROFILES of one Dockerfile (image-packs/profiles.json):
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
# as part of that same publish, so a passing pipeline IS the ship (COMPATIBILITY.md). Unpinned: no digest to
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
# PUSH=0 BUILDS AND PUBLISHES NOTHING: the image lands in this machine's docker store (`--load`) under the tags asked
# for, to be booted by smoke-image.sh with SMOKE_PULL=0. It is ci.yml's `images-dry`, which proves the image a commit
# would ship when a gate in front of `images` failed, so the build and boot failures underneath are said in the same
# run rather than after the gate is fixed. The registry is still READ (every --cache-from below), which is what keeps
# a dry build warm; the job that sets this holds a read-only token as well, so a push could not succeed regardless.
PUSH="${PUSH:-1}"
# Monorepo root (_tools/scripts -> up two). The sandbox image's build context is the whole monorepo so
# `pnpm install --frozen-lockfile` resolves the root lockfile; `pnpm deploy` prunes the final image to core.
root="$(repo_root)"

# How long BuildKit state may sit unused in the builder below before a build sweeps it. A BOUND on a store that
# otherwise grows for the life of the runner host, not a tuning knob — see setup_builder.
BUILDKIT_CACHE_MAX_AGE="${BUILDKIT_CACHE_MAX_AGE:-72h}"

# Prefer docker-container buildx for cache export; builder setup is best-effort and must not fail the build.
# Age-prune its volume-backed state, which lives outside /ci-cache and ordinary volume-preserving Docker sweeps.
# Inline cache in published images is authoritative, so pruning local builder state costs a registry read rather than a cold build.
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

# Build/push requested tags: sandbox uses the prepared trees context; dind-host has its own context. Forward extra args to buildx.
# Inline cache covers these single-stage images without a separate large upload that can fail or silently leave a stale cache.
# Standard owns plain tags; core owns core- tags. Read cache from both profiles because core layers are a prefix of standard.
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
    # zstd layers for the sandbox image (ZSTD=1): smaller to pull and quicker to unpack than gzip, which every update
    # of every host waits on. force-compression recompresses the base image's gzip layers too, so a pull is zstd
    # throughout. Docker reads zstd from Engine 23.0, and ic tells an older engine to update before it pulls
    # (_sandbox/ic/src/docker.rs, too_old_to_unpack). Level 9 is klauspost's "better" encoder: built once per release,
    # pulled by every host.
    #
    # A dry build writes no cache. Its image is loaded, booted once and removed (ci.yml images-dry), so cache keys
    # written into it reach no later build, and preparing them is the one step that outgrew the runner: from
    # 2026-10-18 buildkitd climbed past 22 GB on "preparing layers for inline cache" for the sandbox image and the
    # kernel killed it (exit 255, or `buildkitd.sock: connection refused`), failing every images-dry since. The
    # pushing builds keep `--cache-to type=inline`, which is the cache every build, this one included, reads back.
    local output=--push cache_to=(--cache-to "type=inline")
    if [ "$PUSH" = "0" ]; then
        output=--load
        cache_to=()
    elif [ "${ZSTD:-0}" = "1" ]; then
        output="--output=type=registry,oci-mediatypes=true,compression=zstd,compression-level=9,force-compression=true"
    fi
    registry_retry docker buildx build -f "$dockerfile" "${tag_args[@]}" "${cache_args[@]}" \
        "${cache_to[@]}" \
        "$@" "$output" "$context"
}

case " $IMAGES " in
    *" sandbox "*)
        # The sandbox image COPYs its compiled payload from .image-out — prepare-image-trees.sh must have run first.
        [ -d "$root/.image-out/sandbox" ] || { echo "missing $root/.image-out — run _tools/scripts/image/prepare-image-trees.sh first" >&2; exit 1; }
        # Two profiles of one Dockerfile (see image-packs/profiles.json): `standard` — the core file with the
        # standard feature packs spliced in — owns the plain tags every runner references; the bare core file
        # is the minimal image under `core-` prefixed tags. Composed fresh here so the published bytes always
        # come from the checked-in pack files.
        node "$root/_tools/scripts/image/compose-image-dockerfile.mjs" standard > "$root/.image-out/Dockerfile.standard"
        ZSTD=1 publish sandbox "$root/.image-out/Dockerfile.standard" "$root" --build-context "trees=$root/.image-out"
        ZSTD=1 TAG_PREFIX="core-" publish sandbox "$root/_sandbox/sandbox/Dockerfile" "$root" --build-context "trees=$root/.image-out"
        ;;
esac
case " $IMAGES " in
    *" dind-host "*) publish dind-host "$root/_tools/dind-host/Dockerfile" "$root/_tools/dind-host" ;;
esac
