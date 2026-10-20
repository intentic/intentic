#!/usr/bin/env bash
# Build an Intentic OS image (a bootc container image) with docker or podman.
#
#   bash _os/os-image/build.sh [--edition server|desktop] [--version V] [--channel stable|beta]
#                           [--ic PATH] [--app-rpm PATH] [--tag REF] [--base REF] [--previous PREFIX] [--push]
#
# --ic       the ic binary to bake. Default: _sandbox/ic/dist-bin/ic-linux-<arch> (what build-ic.sh makes for a
#            release), else one built here from source with cargo.
# --app-rpm  desktop edition only: the Intentic desktop app's .rpm. Default: the newest under
#            _editor/desktop-app/dist-bin/, else the newest release's from GitHub.
# --tag      the image reference to tag. Default: ghcr.io/intentic/os[-desktop]:<channel>.
# --previous where the images live whose layer layout a rechunked build keeps: PREFIX/os[-desktop]:<channel>.
#            Default: docker://ghcr.io/intentic, the published ones; `none` lays the layers out afresh.
# The desktop edition is built FROM the server edition of the same version and channel, so it builds that first
# unless the server tag already exists locally (pass --base to name another one).
# OS_ENGINE=podman (or "sudo podman") uses podman instead of docker.
#
# With a rootful podman (CI's "sudo podman") each edition is then rechunked (rechunk below): the tag holds the
# rechunked image, and out/oci/<os|os-desktop> the same image as rpm-ostree wrote it, which is what gets pushed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ENGINE="${OS_ENGINE:-$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)}"
# A command, not a name: CI runs "sudo podman", since bootc-image-builder needs a rootful podman.
read -r -a ENGINE_CMD <<< "$ENGINE"

EDITION=server
VERSION="0.0.0"
CHANNEL=stable
IC=""
APP_RPM=""
TAG=""
BASE=""
PREVIOUS="docker://ghcr.io/intentic"
PUSH=0
while [ $# -gt 0 ]; do
    case "$1" in
        --edition) EDITION="$2"; shift 2 ;;
        --version) VERSION="$2"; shift 2 ;;
        --channel) CHANNEL="$2"; shift 2 ;;
        --ic) IC="$2"; shift 2 ;;
        --app-rpm) APP_RPM="$2"; shift 2 ;;
        --tag) TAG="$2"; shift 2 ;;
        --base) BASE="$2"; shift 2 ;;
        --previous) PREVIOUS="$2"; shift 2 ;;
        --push) PUSH=1; shift ;;
        -h | --help) sed -n '2,19p' "$0"; exit 0 ;;
        *) echo "build.sh: unknown argument $1 (see --help)" >&2; exit 2 ;;
    esac
done
case "$EDITION" in server | desktop) ;; *) echo "build.sh: --edition is server or desktop" >&2; exit 2 ;; esac
case "$CHANNEL" in [a-z0-9]*) ;; *) echo "build.sh: --channel must start with a lowercase letter or digit" >&2; exit 2 ;; esac

case "$(uname -m)" in
    x86_64) ARCH=amd64 ;;
    aarch64) ARCH=arm64 ;;
    *) echo "build.sh: no Intentic OS for $(uname -m)" >&2; exit 2 ;;
esac

SERVER_TAG="ghcr.io/intentic/os:$CHANNEL"
DESKTOP_TAG="ghcr.io/intentic/os-desktop:$CHANNEL"

# Rechunking. A plain build is new from its first layer up: the rpm database and file times differ from build to
# build, so the 818 MB `dnf install` layer had a new digest every release and an update downloaded all of it (282 MB
# compressed, measured 2026-10-20) when only the 6 MB `ic` had changed. rpm-ostree's rechunker
# (`rpm-ostree compose build-chunked-oci`) re-packs the finished filesystem into layers by package instead, each
# layer's bytes a function of its files alone (--format-version=2 is the reproducible format), so a layer whose
# packages did not change keeps its digest and a machine already has it. Two builds of the same packages with a
# different `ic`: 94 of 97 layers kept their digests, and the update came to 18 MB for the server edition and 22 MB
# for the desktop (rechunked metadata, the `intentic-os` layer the Containerfiles mark, the rpm database), against
# 282 MB and about 950 MB before.
#
# It reads and writes podman's own container storage from a privileged container, so it needs rootful podman; docker's
# store is not one it can open. The rechunker is the server edition's base image, which carries rpm-ostree and is in
# the store already: the same floating tag the Containerfile builds FROM.
RECHUNKER="$(sed -n 's/^ARG BASE=//p' "$HERE/Containerfile")"
# Layers in the rechunked image. On an update that bumped docker-buildx and added four packages: 358 MB to download
# with rpm-ostree's default of 64, 249 MB with 96, 248 MB with 128, since more layers mean smaller bins of small
# packages. Not 128: docker's overlay2 store takes no image past 128 layers, and the desktop edition is built with
# its own layers stacked on the server's (podman 4.9, the runner's, built it on 97; verified 2026-10-20).
MAX_LAYERS=96
RECHUNK=0
if [[ "$ENGINE" == *podman* ]] && [ "$("${ENGINE_CMD[@]}" info --format '{{.Host.Security.Rootless}}')" = false ]; then
    RECHUNK=1
else
    echo "build.sh: not rechunking ($ENGINE): rpm-ostree needs rootful podman's store (OS_ENGINE=\"sudo podman\"); the" \
        "image works the same, only an update to it downloads more"
fi

# Where an edition is built: under its own tag, or, when it is to be rechunked, under a scratch name rechunk removes.
build_ref() {
    if [ "$RECHUNK" = 1 ]; then echo "localhost/intentic-$1-unchunked"; else echo "$2"; fi
}

# rechunk <built> <tag> <os|os-desktop>: rechunk <built> into out/oci/<name> and, from there, into <tag>.
#
# The layer layout follows the published image of the same edition and channel (--previous-build), which rpm-ostree
# reads from the registry without pulling it: packages keep the layer they had, a new one joins the layer kept for
# new packages, so a release does not reshuffle what a machine already has. A first release, a new channel or no
# network lays them out afresh. rpm-ostree takes the layout from each layer's ostree.components annotation, which a
# push from podman's store drops (podman 4.9's and Fedora 44's skopeo 1.22 alike), so it is the OCI layout written
# here that gets pushed.
rechunk() {
    local built="$1" tag="$2" name="$3" graphroot layout="$HERE/out/oci/$3"
    graphroot="$("${ENGINE_CMD[@]}" info --format '{{.Store.GraphRoot}}')"
    mkdir -p "$layout"
    echo "build.sh: rechunking $built into $tag ($MAX_LAYERS layers)"
    "${ENGINE_CMD[@]}" run --rm -i --privileged --security-opt label=type:unconfined_t \
        -v "$graphroot:/var/lib/containers/storage" -v "$layout:/layout" \
        "$RECHUNKER" bash -s -- "$built" "$tag" "$PREVIOUS/$name:$CHANNEL" "$MAX_LAYERS" <<'EOF'
set -euo pipefail
built="$1" tag="$2" previous="$3" max_layers="$4"
# An empty layout, not an empty directory: with no --previous-build rpm-ostree opens --output as the baseline, and an
# empty directory is an error to it where an empty layout is no image.
find /layout -mindepth 1 -delete
echo '{"imageLayoutVersion":"1.0.0"}' > /layout/oci-layout
echo '{"schemaVersion":2,"manifests":[]}' > /layout/index.json
baseline=()
if [[ "$previous" == none/* ]]; then
    echo "build.sh: laying the layers out afresh (--previous none)"
elif skopeo inspect --raw "$previous" >/dev/null 2>&1; then
    baseline=(--previous-build "$previous")
else
    echo "build.sh: no $previous to keep the layer layout of; laying it out afresh"
fi
rpm-ostree compose build-chunked-oci --bootc --format-version=2 --max-layers="$max_layers" "${baseline[@]}" \
    --from="$built" --output=oci:/layout:latest
skopeo copy --quiet oci:/layout:latest "containers-storage:$tag"
EOF
    "${ENGINE_CMD[@]}" rmi "$built" >/dev/null
    # What ships is the rechunked image, so it is linted too; the Containerfile linted only what it built.
    "${ENGINE_CMD[@]}" run --rm "$tag" bootc container lint
}

build_server() {
    local tag="$1"
    mkdir -p "$HERE/bin"
    if [ -n "$IC" ]; then
        cp "$IC" "$HERE/bin/ic"
    elif [ -x "$REPO/_sandbox/ic/dist-bin/ic-linux-$ARCH" ]; then
        cp "$REPO/_sandbox/ic/dist-bin/ic-linux-$ARCH" "$HERE/bin/ic"
    else
        echo "build.sh: building ic from source (no --ic and no _sandbox/ic/dist-bin/ic-linux-$ARCH)"
        cargo build --release --manifest-path "$REPO/_sandbox/ic/Cargo.toml"
        cp "${CARGO_TARGET_DIR:-$REPO/_sandbox/ic/target}/release/ic" "$HERE/bin/ic"
    fi
    chmod 0755 "$HERE/bin/ic"
    local built
    built="$(build_ref os "$tag")"
    "${ENGINE_CMD[@]}" build \
        --build-arg VERSION="$VERSION" \
        --build-arg CHANNEL="$CHANNEL" \
        --build-arg REPOSITORY=ghcr.io/intentic/os \
        -f "$HERE/Containerfile" -t "$built" "$HERE"
    [ "$RECHUNK" = 0 ] || rechunk "$built" "$tag" os
}

build_desktop() {
    local tag="$1" base="$2"
    mkdir -p "$HERE/desktop/rpm"
    rm -f "$HERE/desktop/rpm/"*.rpm
    if [ -z "$APP_RPM" ]; then
        APP_RPM="$(ls -t "$REPO"/_editor/desktop-app/dist-bin/*.rpm 2>/dev/null | head -n 1 || true)"
    fi
    if [ -n "$APP_RPM" ]; then
        cp "$APP_RPM" "$HERE/desktop/rpm/"
    else
        echo "build.sh: fetching the newest released desktop app .rpm"
        # Unauthenticated API calls share a small per-IP limit that a CI runner's address often has spent already
        # (a 403); CI hands its GITHUB_TOKEN in, a local build without one goes unauthenticated.
        auth=()
        [ -z "${GITHUB_TOKEN:-}" ] || auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
        url="$(curl -fsSL "${auth[@]}" https://api.github.com/repos/intentic/intentic/releases/latest \
            | grep -o '"browser_download_url": *"[^"]*x86_64\.rpm"' | head -n 1 | cut -d'"' -f4)"
        [ -n "$url" ] || { echo "build.sh: no .rpm on the newest release; pass --app-rpm" >&2; exit 1; }
        curl -fsSL -o "$HERE/desktop/rpm/intentic.rpm" "$url"
    fi
    local built
    built="$(build_ref os-desktop "$tag")"
    "${ENGINE_CMD[@]}" build \
        --build-arg BASE="$base" \
        --build-arg VERSION="$VERSION" \
        --build-arg CHANNEL="$CHANNEL" \
        --build-arg REPOSITORY=ghcr.io/intentic/os-desktop \
        -f "$HERE/Containerfile.desktop" -t "$built" "$HERE"
    [ "$RECHUNK" = 0 ] || rechunk "$built" "$tag" os-desktop
}

if [ "$EDITION" = server ]; then
    TAG="${TAG:-$SERVER_TAG}"
    build_server "$TAG"
else
    TAG="${TAG:-$DESKTOP_TAG}"
    if [ -z "$BASE" ]; then
        BASE="$SERVER_TAG"
        "${ENGINE_CMD[@]}" image inspect "$BASE" >/dev/null 2>&1 || build_server "$BASE"
    fi
    build_desktop "$TAG" "$BASE"
fi

echo "build.sh: built $TAG ($EDITION, $VERSION, $CHANNEL)"
if [ "$PUSH" = 1 ]; then
    if [ "$RECHUNK" = 1 ]; then
        # The OCI layout, not the store (rechunk says why), with skopeo under the engine's own sudo, if any.
        layout="$HERE/out/oci/$([ "$EDITION" = server ] && echo os || echo os-desktop)"
        "${ENGINE_CMD[@]:0:${#ENGINE_CMD[@]}-1}" skopeo copy "oci:$layout" "docker://$TAG"
    else
        "${ENGINE_CMD[@]}" push "$TAG"
    fi
fi
