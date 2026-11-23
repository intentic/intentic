#!/usr/bin/env bash
# Install, update and check Intentic OS on a physical test machine, from a hub machine on the same local network.
#
#   metal.sh status                     which OS answers on the box, what it booted, its boot entries, the registry
#   metal.sh build [--edition server|desktop] [--tag dev] [--ic PATH] [--app-rpm PATH]
#                                       build ic and the edition from this checkout, put the dev layer on it
#                                       (Containerfile.dev) and push it to the registry on the hub
#   metal.sh reinstall [--edition E | --image REF] [--loopback FILE]
#                                       from the controller: wipe the target disk, `bootc install` the image onto it,
#                                       boot it once and check it. --loopback FILE installs into a disk image on the
#                                       controller instead, touching no disk and no boot entry: the same path, dry
#   metal.sh update [--edition E | --image REF]
#                                       on the target: stage the image (`bootc switch` to it, or `ic os update` when
#                                       the box follows it already), reboot into it, check it
#   metal.sh target | controller        reboot the box into the other OS, for one boot
#   metal.sh check                      checks.sh against the target, with the Kata check
#   metal.sh logs [LINES]               from the controller: the target's last boot, read off its disk
#   metal.sh sh COMMAND…                run COMMAND as root on whichever OS answers
#
# The box has two OSes on two disks. The controller (any Linux with podman and efibootmgr) stays first in BootOrder;
# Intentic OS, on the target disk, is booted through the firmware's one-time BootNext. So any reset (a hang the dev
# layer's watchdog catches, a panic, a power cut) lands on the controller, which can always reinstall.
#
# What is the machine's lives in an env file outside the repository ($METAL_ENV, default
# ~/.config/intentic-os-metal/env), beside the lock and the last check's output:
#   METAL_HOST              the address both OSes answer on
#   METAL_SSH_KEY           the private key root signs in with on both; the dev layer bakes in its .pub
#   METAL_REGISTRY          host:port of the hub's registry as the box reaches it (plain HTTP; pushed as localhost)
#   METAL_CONTROLLER_ENTRY  the label of the controller's EFI boot entry
#   METAL_TARGET_DISK       /dev/disk/by-id/… of the whole disk Intentic OS is installed on
#   METAL_SSH_PORT, METAL_PAIR_URL   optional: 22 and http://$METAL_HOST/ unless a VM stands in for the machine
# A command that changes the box holds a lock, so two runs never reinstall or reboot it at once.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
METAL_ENV="${METAL_ENV:-$HOME/.config/intentic-os-metal/env}"

say() { printf 'metal.sh: %s\n' "$*"; }
die() { printf 'metal.sh: %s\n' "$*" >&2; exit 1; }

case "${1:-}" in -h | --help | "") sed -n '2,32p' "$0"; exit 0 ;; esac
[ -f "$METAL_ENV" ] || die "no $METAL_ENV: it names the box (see --help)"
# shellcheck disable=SC1090
. "$METAL_ENV"
: "${METAL_HOST:?is not set in $METAL_ENV}" "${METAL_SSH_KEY:?is not set in $METAL_ENV}"
: "${METAL_REGISTRY:?is not set in $METAL_ENV}" "${METAL_CONTROLLER_ENTRY:?is not set in $METAL_ENV}"
METAL_TARGET_DISK="${METAL_TARGET_DISK:-}"
METAL_SSH_PORT="${METAL_SSH_PORT:-22}"
METAL_PAIR_URL="${METAL_PAIR_URL:-http://$METAL_HOST/}"
STATE="$(dirname "$METAL_ENV")"
PUSH_REGISTRY="localhost:${METAL_REGISTRY##*:}"

# Both OSes answer on the same address with their own host key, and a reinstall makes a new one: not pinned.
on_box() {
    ssh -q -i "$METAL_SSH_KEY" -p "$METAL_SSH_PORT" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 "root@$METAL_HOST" "$@"
}
# metal-box.sh, sent along: the box needs nothing of this checkout installed.
box() { on_box "bash -c \"\$(cat)\" metal-box $(printf '%q ' "$@")" < "$HERE/metal-box.sh"; }

role() { box role 2>/dev/null || echo down; }

need_disk() {
    [ -n "$METAL_TARGET_DISK" ] || die "METAL_TARGET_DISK is not set in $METAL_ENV: the box has no target disk yet"
    case "$METAL_TARGET_DISK" in /dev/disk/by-id/*) ;; *) die "METAL_TARGET_DISK must be a /dev/disk/by-id/ path" ;; esac
}

lock() {
    exec 9>"$STATE/lock"
    flock -n 9 || die "the box is busy: $(cat "$STATE/lock.holder" 2>/dev/null || echo 'another metal.sh run')"
    printf '%s, since %s (pid %s on %s)\n' "$1" "$(date -u +%FT%TZ)" "$$" "$(hostname)" > "$STATE/lock.holder"
}

image_ref() { # image_ref <edition> <tag>
    case "$1" in server) echo "$METAL_REGISTRY/intentic/os:$2" ;; desktop) echo "$METAL_REGISTRY/intentic/os-desktop:$2" ;;
        *) die "--edition is server or desktop" ;; esac
}

# The manifest digest the registry holds for <repository>:<tag>, which bootc records as the booted imageDigest.
registry_digest() {
    curl -fsSI -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
        -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
        "http://$PUSH_REGISTRY/v2/$1/manifests/$2" | tr -d '\r' | awk 'tolower($1) == "docker-content-digest:" { print $2 }'
}

# Wait for the box to go away (the reboot began) and come back as <role>. A box that comes back as the other one
# booted it instead: the target failed (or the firmware ignored BootNext) and it fell back.
await() {
    local want="$1" limit="${2:-900}" start got
    start="$(date +%s)"
    while [ "$(role)" != down ]; do
        [ $(($(date +%s) - start)) -lt 180 ] || die "the box never went down for the reboot"
        sleep 3
    done
    say "the box is rebooting; waiting for the $want"
    while :; do
        got="$(role)"
        if [ "$got" = "$want" ]; then say "the $want answers after $(($(date +%s) - start))s"; return 0; fi
        if [ "$got" != down ]; then
            die "the $got answered instead of the $want: that boot fell back (metal.sh logs reads the target's journal)"
        fi
        [ $(($(date +%s) - start)) -lt "$limit" ] ||
            die "nothing answers after ${limit}s: hung in firmware or early boot; a power cycle returns to the controller"
        sleep 5
    done
}

check() { # check [checks.sh args…]
    mkdir -p "$STATE/last-check"
    bash "$HERE/checks.sh" --host "$METAL_HOST" --port "$METAL_SSH_PORT" --key "$METAL_SSH_KEY" --pair-url "$METAL_PAIR_URL" \
        --out "$STATE/last-check" --kata "$@"
}

cmd_status() {
    local r
    r="$(role)"
    say "$METAL_HOST answers as: $r"
    case "$r" in
        target) on_box 'ic os status --json' | jq -c '{edition, version, channel, image, booted: .booted.digest,
            staged: .staged.digest, rebootRequired, health: .health.verdict, isolation, vmRuntime}' ;;
        controller) on_box '. /etc/os-release; echo "$PRETTY_NAME, $(uname -r)"' ;;
        down) say "nothing answers: off, rebooting, or hung (a power cycle returns to the controller)" ;;
    esac
    if [ "$r" != down ]; then
        if [ -n "$METAL_TARGET_DISK" ]; then box entries "$METAL_TARGET_DISK" "$METAL_CONTROLLER_ENTRY"
        else say "no target disk configured (METAL_TARGET_DISK)"; fi
    fi
    for repo in os os-desktop; do
        say "registry intentic/$repo: $(curl -fsS "http://$PUSH_REGISTRY/v2/intentic/$repo/tags/list" 2>/dev/null | jq -c .tags || echo none)"
    done
}

cmd_build() {
    local edition=server tag=dev ic="" app_rpm="" version base name ref digest
    while [ $# -gt 0 ]; do
        case "$1" in
            --edition) edition="$2"; shift 2 ;;
            --tag) tag="$2"; shift 2 ;;
            --ic) ic="$2"; shift 2 ;;
            --app-rpm) app_rpm="$2"; shift 2 ;;
            *) die "build: unknown argument $1" ;;
        esac
    done
    ref="$(image_ref "$edition" "$tag")"
    exec 8>"$STATE/build.lock"
    flock -n 8 || die "another metal.sh build is running"
    version="0.0.0-dev.$(date -u +%Y%m%d%H%M%S)"
    mkdir -p "$HERE/out/metal"
    if [ -z "$ic" ]; then
        # ic from this checkout, in a Rust container: its cargo registry and target directory are volumes, so the
        # next build is incremental. rustls throughout, so nothing of the build host's libraries is linked in.
        say "building ic from this checkout"
        docker run --rm -v "$REPO:/src:ro" -v "$HERE/out/metal:/out" \
            -v intentic-os-metal-cargo:/usr/local/cargo/registry -v intentic-os-metal-target:/target \
            -e CARGO_TARGET_DIR=/target rust:1-trixie \
            sh -c 'cargo build --release --locked --manifest-path /src/_sandbox/ic/Cargo.toml && cp /target/release/ic /out/ic'
        ic="$HERE/out/metal/ic"
    fi
    base="localhost/intentic-os-metal/os:$tag"
    bash "$HERE/build.sh" --edition server --channel "$tag" --version "$version" --ic "$ic" --tag "$base"
    name=os
    if [ "$edition" = desktop ]; then
        bash "$HERE/build.sh" --edition desktop --channel "$tag" --version "$version" --base "$base" \
            ${app_rpm:+--app-rpm "$app_rpm"} --tag "localhost/intentic-os-metal/os-desktop:$tag"
        base="localhost/intentic-os-metal/os-desktop:$tag"
        name=os-desktop
    fi
    # One manifest, no provenance index: what bootc pulls and records is then the digest the registry names.
    docker build --provenance=false --sbom=false -f "$HERE/Containerfile.dev" \
        --build-arg BASE="$base" \
        --build-arg DEV_SSH_AUTHORIZED="$(cat "$METAL_SSH_KEY.pub")" \
        --build-arg DEV_REGISTRY="$METAL_REGISTRY" \
        -t "$PUSH_REGISTRY/intentic/$name:$tag" "$HERE"
    docker push -q "$PUSH_REGISTRY/intentic/$name:$tag" >/dev/null
    digest="$(registry_digest "intentic/$name" "$tag")"
    say "pushed $ref ($digest), version $version"
}

pick_image() { # pick_image <edition> <image>: the image a reinstall or update takes
    if [ -n "$2" ]; then echo "$2"; else image_ref "${1:-server}" dev; fi
}

cmd_reinstall() {
    local edition="" image="" loopback="" r
    while [ $# -gt 0 ]; do
        case "$1" in
            --edition) edition="$2"; shift 2 ;;
            --image) image="$2"; shift 2 ;;
            --loopback) loopback="$2"; shift 2 ;;
            *) die "reinstall: unknown argument $1" ;;
        esac
    done
    image="$(pick_image "$edition" "$image")"
    lock "reinstall $image"
    r="$(role)"
    if [ -n "$loopback" ]; then
        [ "$r" = controller ] || die "a loopback install runs on the controller, and the box answers as: $r"
        box install-loopback "$image" "$loopback"
        return 0
    fi
    need_disk
    case "$r" in
        target)
            box boot-next controller "$METAL_TARGET_DISK" "$METAL_CONTROLLER_ENTRY"
            box reboot
            await controller ;;
        controller) ;;
        down) die "nothing answers on $METAL_HOST: off or hung; a power cycle returns to the controller" ;;
    esac
    box install "$image" "$METAL_TARGET_DISK"
    box target-entry "$METAL_TARGET_DISK"
    box controller-first "$METAL_TARGET_DISK" "$METAL_CONTROLLER_ENTRY"
    box boot-next target "$METAL_TARGET_DISK" "$METAL_CONTROLLER_ENTRY"
    box reboot
    await target 1200
    check --image "$image"
}

cmd_update() {
    local edition="" image="" follows staged
    while [ $# -gt 0 ]; do
        case "$1" in
            --edition) edition="$2"; shift 2 ;;
            --image) image="$2"; shift 2 ;;
            *) die "update: unknown argument $1" ;;
        esac
    done
    image="$(pick_image "$edition" "$image")"
    need_disk
    lock "update to $image"
    [ "$(role)" = target ] || die "Intentic OS is not up on the box: metal.sh target, or metal.sh reinstall"
    follows="$(on_box "bootc status --json | jq -r '.spec.image.image // empty'")"
    if [ "$follows" = "$image" ]; then
        say "the box follows $image: staging through ic os update"
        on_box 'ic os update'
    else
        say "switching the box from ${follows:-nothing} to $image"
        on_box "bootc switch '$image'"
    fi
    staged="$(on_box "bootc status --json | jq -r '.status.staged.image.imageDigest // empty'")"
    [ -n "$staged" ] || { say "nothing new was staged: the box runs $image as it is"; return 0; }
    box boot-next target "$METAL_TARGET_DISK" "$METAL_CONTROLLER_ENTRY"
    box reboot
    await target
    check --image "$image" --digest "$staged"
}

cmd_switch() { # cmd_switch target|controller
    local want="$1" r
    need_disk
    lock "reboot into the $want"
    r="$(role)"
    [ "$r" != "$want" ] || { say "the $want is up already"; return 0; }
    [ "$r" != down ] || die "nothing answers on $METAL_HOST: off or hung; a power cycle returns to the controller"
    box boot-next "$want" "$METAL_TARGET_DISK" "$METAL_CONTROLLER_ENTRY"
    box reboot
    await "$want"
}

verb="$1"
shift
case "$verb" in
    status) cmd_status ;;
    build) cmd_build "$@" ;;
    reinstall) cmd_reinstall "$@" ;;
    update) cmd_update "$@" ;;
    target | controller) cmd_switch "$verb" ;;
    check) [ "$(role)" = target ] || die "Intentic OS is not up on the box"; check "$@" ;;
    logs) need_disk; box logs "$METAL_TARGET_DISK" "${1:-300}" ;;
    sh) [ $# -gt 0 ] || die "sh: a command to run"; on_box "$*" ;;
    *) die "unknown command $verb (see --help)" ;;
esac
