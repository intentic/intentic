#!/usr/bin/env bash
# Build an Intentic OS image (a bootc container image) with docker or podman.
#
#   bash _os/os-image/build.sh [--edition server|desktop] [--version V] [--channel stable|beta]
#                           [--ic PATH] [--app-rpm PATH] [--tag REF] [--base REF] [--push]
#
# --ic       the ic binary to bake. Default: _sandbox/ic/dist-bin/ic-linux-<arch> (what build-ic.sh makes for a
#            release), else one built here from source with cargo.
# --app-rpm  desktop edition only: the Intentic desktop app's .rpm. Default: the newest under
#            _editor/desktop-app/dist-bin/, else the newest release's from GitHub.
# --tag      the image reference to tag. Default: ghcr.io/intentic/os[-desktop]:<channel>.
# The desktop edition is built FROM the server edition of the same version and channel, so it builds that first
# unless the server tag already exists locally (pass --base to name another one).
# OS_ENGINE=podman (or "sudo podman") uses podman instead of docker.
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
        --push) PUSH=1; shift ;;
        -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
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
    "${ENGINE_CMD[@]}" build \
        --build-arg VERSION="$VERSION" \
        --build-arg CHANNEL="$CHANNEL" \
        --build-arg REPOSITORY=ghcr.io/intentic/os \
        -f "$HERE/Containerfile" -t "$tag" "$HERE"
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
        url="$(curl -fsSL https://api.github.com/repos/intentic/intentic/releases/latest \
            | grep -o '"browser_download_url": *"[^"]*x86_64\.rpm"' | head -n 1 | cut -d'"' -f4)"
        [ -n "$url" ] || { echo "build.sh: no .rpm on the newest release; pass --app-rpm" >&2; exit 1; }
        curl -fsSL -o "$HERE/desktop/rpm/intentic.rpm" "$url"
    fi
    "${ENGINE_CMD[@]}" build \
        --build-arg BASE="$base" \
        --build-arg VERSION="$VERSION" \
        --build-arg CHANNEL="$CHANNEL" \
        --build-arg REPOSITORY=ghcr.io/intentic/os-desktop \
        -f "$HERE/Containerfile.desktop" -t "$tag" "$HERE"
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
    "${ENGINE_CMD[@]}" push "$TAG"
fi
