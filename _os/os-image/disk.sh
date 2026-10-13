#!/usr/bin/env bash
# Turn a built Intentic OS image into something a machine boots, with bootc-image-builder:
#
#   bash _os/os-image/disk.sh [--type qcow2|raw|anaconda-iso] [--image REF] [--config FILE] [--out DIR]
#
#   qcow2         a VM disk (what smoke.sh boots)
#   raw           a disk image to write straight onto a machine's drive (dd, or a USB stick that becomes the system)
#   anaconda-iso  the installer: boots from USB, erases the machine's first disk and installs Intentic OS on it,
#                 encrypted, with the disk bound to the machine's TPM2 on its first boot (installer/bib-config.toml)
#
# --image  default ghcr.io/intentic/os:stable
# --config bootc-image-builder's config. Default: installer/bib-config.toml for anaconda-iso, none otherwise.
# --out    default _os/os-image/out/<type>
#
# bootc-image-builder reads the image from podman's container storage. With OS_ENGINE=podman (CI) that is the host's
# own; with docker (a sandbox, a developer machine) the image is first copied into a podman store kept in a docker
# volume, by the podman inside the image itself.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="${OS_ENGINE:-$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)}"
# A command, not a name: CI runs "sudo podman", since bootc-image-builder needs a rootful podman.
read -r -a ENGINE_CMD <<< "$ENGINE"
BIB="${BIB_IMAGE:-quay.io/centos-bootc/bootc-image-builder:latest}"

TYPE=qcow2
IMAGE=ghcr.io/intentic/os:stable
CONFIG=""
OUT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --type) TYPE="$2"; shift 2 ;;
        --image) IMAGE="$2"; shift 2 ;;
        --config) CONFIG="$2"; shift 2 ;;
        --out) OUT="$2"; shift 2 ;;
        -h | --help) sed -n '2,21p' "$0"; exit 0 ;;
        *) echo "disk.sh: unknown argument $1 (see --help)" >&2; exit 2 ;;
    esac
done
case "$TYPE" in qcow2 | raw | anaconda-iso) ;; *) echo "disk.sh: --type is qcow2, raw or anaconda-iso" >&2; exit 2 ;; esac
if [ -z "$CONFIG" ] && [ "$TYPE" = anaconda-iso ]; then
    CONFIG="$HERE/installer/bib-config.toml"
fi
OUT="${OUT:-$HERE/out/$TYPE}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

config_mount=()
config_arg=()
if [ -n "$CONFIG" ]; then
    CONFIG="$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")"
    ext="${CONFIG##*.}"
    config_mount=(-v "$CONFIG:/config.$ext:ro")
    config_arg=(--config "/config.$ext")
fi

if [[ "$ENGINE" == *podman* ]]; then
    store=(-v /var/lib/containers/storage:/var/lib/containers/storage)
else
    # A docker volume, not a host directory: podman's overlay driver needs a real filesystem under it, which a
    # directory inside a container's own overlay root is not.
    STORE_VOLUME="${OS_PODMAN_STORE:-intentic-os-podman-store}"
    docker volume create "$STORE_VOLUME" >/dev/null
    echo "disk.sh: copying $IMAGE into the podman store ($STORE_VOLUME)"
    docker save "$IMAGE" | docker run --rm -i --privileged \
        -v "$STORE_VOLUME:/var/lib/containers" \
        --entrypoint podman "$IMAGE" load
    # Mounted where bootc-image-builder looks, exactly: it checks that path itself, not a parent of it.
    store=(--mount "type=volume,src=$STORE_VOLUME,dst=/var/lib/containers/storage,volume-subpath=storage")
fi

echo "disk.sh: building $TYPE from $IMAGE into $OUT"
"${ENGINE_CMD[@]}" run --rm --privileged --pull=missing \
    --security-opt label=type:unconfined_t \
    "${store[@]}" "${config_mount[@]}" \
    -v "$OUT:/output" \
    "$BIB" --type "$TYPE" --rootfs xfs "${config_arg[@]}" "$IMAGE"

find "$OUT" -maxdepth 2 -type f \( -name '*.qcow2' -o -name '*.raw' -o -name '*.iso' \) -printf 'disk.sh: %p (%s bytes)\n'
