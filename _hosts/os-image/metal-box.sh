#!/usr/bin/env bash
# The half of metal.sh that runs ON the test machine, as root, in whichever OS answers: metal.sh sends this file over
# SSH for each step (`bash -c "$(cat)" metal-box <verb> <args>`), so nothing has to be installed there first.
#
#   role                                  target (Intentic OS) or controller (anything else)
#   entries DISK LABEL                    the controller's and the target's EFI boot entries, and BootOrder
#   guard DISK                            refuse unless DISK is a whole, unmounted disk the controller does not run from
#   install IMAGE DISK                    wipe DISK and `bootc install` IMAGE onto it (from the controller)
#   install-loopback IMAGE FILE           the same install into a disk image FILE: no disk, no firmware entry touched
#   inspect-image FILE                    what an install left in a disk image: partitions, boot files, release
#   target-entry DISK                     make sure the firmware has a boot entry for DISK's EFI partition
#   controller-first DISK LABEL           keep the controller first in BootOrder
#   boot-next target|controller DISK LABEL
#                                         the entry the next boot (only) takes
#   reboot                                reboot in two seconds, detached from this SSH session
#   logs DISK [LINES]                     from the controller: the target's last boot, read off its disk
set -euo pipefail
ESP_TYPE=c12a7328-f81f-11d2-ba4b-00a0c93ec93b
say() { printf 'metal-box: %s\n' "$*"; }
die() { printf 'metal-box: %s\n' "$*" >&2; exit 1; }

role() { if [ -f /usr/lib/intentic-os/release.json ]; then echo target; else echo controller; fi; }

disk_dev() {
    local d
    d="$(readlink -f "$1")"
    [ -b "$d" ] || die "$1 is not a block device here"
    echo "$d"
}

# The EFI system partition on a disk: its device and its PARTUUID.
esp_of() { lsblk -nrpo NAME,PARTTYPE "$1" | awk -v t="$ESP_TYPE" 'tolower($2) == t { print $1; exit }'; }

entry_by_label() {
    efibootmgr | awk -v label="$1" '
        /^Boot[0-9A-Fa-f]{4}/ {
            name = $0; sub(/^Boot[0-9A-Fa-f]{4}\*? /, "", name); sub(/\t.*/, "", name)
            if (name == label) { print substr($1, 5, 4); exit }
        }'
}

# An entry whose device path names the disk's EFI partition (by PARTUUID), whatever its label.
entry_for_disk() {
    local esp uuid
    esp="$(esp_of "$1")"
    [ -n "$esp" ] || return 0
    uuid="$(lsblk -dno PARTUUID "$esp")"
    [ -n "$uuid" ] || return 0
    efibootmgr -v | awk -v g="$uuid" '/^Boot[0-9A-Fa-f]{4}/ && index(tolower($0), tolower(g)) { print substr($1, 5, 4); exit }'
}

boot_order() { efibootmgr | sed -n 's/^BootOrder: //p'; }

entries() {
    local d c t
    d="$(disk_dev "$1")"
    c="$(entry_by_label "$2")"
    t="$(entry_for_disk "$d")"
    echo "controller=${c:-none} target=${t:-none} order=$(boot_order) next=$(efibootmgr | sed -n 's/^BootNext: //p')"
}

guard() {
    local d root
    d="$(disk_dev "$1")"
    [ "$(lsblk -dno TYPE "$d")" = disk ] || die "$1 ($d) is not a whole disk"
    [ "$(lsblk -dno RM "$d")" = 0 ] || die "$1 ($d) is removable; the target is an internal disk"
    root="$(findmnt -nvo SOURCE /)"
    if lsblk -nrpo NAME "$d" | grep -qxF "$root"; then die "$1 ($d) holds this system's root"; fi
    if lsblk -nro MOUNTPOINTS "$d" | grep -q .; then
        die "$1 ($d) has something mounted or swapped on: $(lsblk -nro MOUNTPOINTS "$d" | paste -sd' ')"
    fi
    say "$1 is $d ($(lsblk -dno SIZE,MODEL "$d" | xargs)), not in use"
}

# bootc installs from the image it runs in, which it finds in the host's container storage.
#
# systemd.gpt_auto=0: `bootc install to-disk` lays out no /boot partition and writes no fstab, so on Fedora 44
# (systemd 259) systemd-gpt-auto-generator automounts the EFI partition on /boot, over ostree's own /boot. bootc
# mounts it there while staging an update, systemd takes it down at shutdown, and ostree-finalize-staged then fails
# ("Remounting /boot read-write: Invalid argument"): the update is dropped and the machine boots what it ran before
# (seen 2026-11-23, ostree 2026.4, bootc 1.17.1). The installer ISO makes a /boot partition, so it should not be.
TO_DISK_KARGS=(--karg systemd.gpt_auto=0)
bootc_install() {
    local image="$1"; shift
    podman pull "$image" >/dev/null
    say "installing $image ($(podman image inspect --format '{{.Digest}}' "$image"))"
    podman run --rm --privileged --pid=host --security-opt label=type:unconfined_t \
        -v /dev:/dev -v /var/lib/containers:/var/lib/containers "$@"
}

install_disk() {
    local image="$1" d
    guard "$2"
    d="$(disk_dev "$2")"
    bootc_install "$image" "$image" bootc install to-disk --wipe "${TO_DISK_KARGS[@]}" "$d"
}

install_loopback() {
    local image="$1" file="$2" dir
    dir="$(dirname "$file")"
    mkdir -p "$dir"
    rm -f "$file"
    truncate -s 30G "$file"
    # --generic-image: the firmware's boot entries are left alone; this is a file, not this machine's disk.
    bootc_install "$image" -v "$dir:/output" "$image" \
        bootc install to-disk --generic-image --via-loopback --wipe "${TO_DISK_KARGS[@]}" "/output/$(basename "$file")"
    inspect_image "$file"
}

# What an install left in a disk image: its partitions, the boot files on its EFI partition, the deployed release.
inspect_image() {
    local file="$1" loop esp root mnt
    loop="$(losetup -fP --show -r "$file")"
    mnt="$(mktemp -d)"
    # Expanded now: the trap runs at exit, after this function's locals are gone.
    # shellcheck disable=SC2064
    trap "umount -q '$mnt' 2>/dev/null || true; losetup -d '$loop' 2>/dev/null || true; rmdir '$mnt' 2>/dev/null || true" EXIT
    # lsblk reads partition types and filesystems from udev, which has not seen a new loop device yet.
    udevadm settle
    lsblk -o NAME,SIZE,FSTYPE,PARTTYPENAME,LABEL "$loop"
    esp="$(esp_of "$loop")"
    [ -n "$esp" ] || die "the image has no EFI system partition"
    mount -o ro "$esp" "$mnt"
    say "EFI partition: $(cd "$mnt" && find . -iname '*.efi' | sed 's|^\./||' | sort | paste -sd' ')"
    umount "$mnt"
    root="$(lsblk -nrpo NAME,FSTYPE "$loop" | awk '$2 == "xfs" { print $1; exit }')"
    [ -n "$root" ] || die "the image has no XFS root"
    mount -o ro,norecovery "$root" "$mnt"
    say "deployed: $(cat "$mnt"/ostree/deploy/*/deploy/*/usr/lib/intentic-os/release.json)"
    say "dev key: $(cut -c1-40 "$mnt"/ostree/deploy/*/deploy/*/usr/share/intentic-os-dev/authorized_keys)…"
    say "disk image: $file ($(du -h --apparent-size "$file" | cut -f1) apparent, $(du -h "$file" | cut -f1) written)"
}

target_entry() {
    local d esp part loader mnt
    d="$(disk_dev "$1")"
    if [ -n "$(entry_for_disk "$d")" ]; then
        say "the firmware has an entry for $d: Boot$(entry_for_disk "$d")"
        return 0
    fi
    esp="$(esp_of "$d")"
    [ -n "$esp" ] || die "$d has no EFI system partition: is Intentic OS installed on it?"
    part="$(cat "/sys/class/block/$(basename "$esp")/partition")"
    mnt="$(mktemp -d)"
    mount -o ro "$esp" "$mnt"
    if [ -f "$mnt/EFI/fedora/shimx64.efi" ]; then loader='\EFI\fedora\shimx64.efi'; else loader='\EFI\BOOT\BOOTX64.EFI'; fi
    umount "$mnt"; rmdir "$mnt"
    efibootmgr -q -c -d "$d" -p "$part" -L "Intentic OS" -l "$loader"
    say "added the firmware entry Boot$(entry_for_disk "$d") for $d ($loader)"
}

controller_first() {
    local d c order new
    d="$(disk_dev "$1")"
    c="$(entry_by_label "$2")"
    [ -n "$c" ] || die "no EFI boot entry labelled '$2' (the controller's)"
    order="$(boot_order)"
    new="$(printf '%s\n' "$c" "$(tr ',' '\n' <<<"$order" | grep -vxF "$c")" | grep . | paste -sd,)"
    if [ "$new" != "$order" ]; then efibootmgr -q -o "$new"; say "BootOrder $order -> $new"; fi
}

boot_next() {
    local which="$1" d n
    d="$(disk_dev "$2")"
    case "$which" in
        target) n="$(entry_for_disk "$d")" ;;
        controller) n="$(entry_by_label "$3")" ;;
        *) die "boot-next: target or controller" ;;
    esac
    [ -n "$n" ] || die "no EFI boot entry for the $which"
    efibootmgr -q -n "$n"
    say "the next boot (only) takes Boot$n, the $which"
}

reboot_soon() {
    local cmd=(systemctl reboot)
    # On Intentic OS the orderly way: resume asks for the sandboxes, then the record greenboot checks against.
    [ "$(role)" = target ] && cmd=(ic os reboot)
    systemd-run --quiet --collect --on-active=2 --unit="metal-reboot-$$" "${cmd[@]}"
    say "rebooting ($(role), ${cmd[*]})"
}

logs() {
    local d root mnt journal boot lines="${2:-300}"
    [ "$(role)" = controller ] || die "logs reads the target's disk from the controller; on the target, use journalctl"
    d="$(disk_dev "$1")"
    root="$(lsblk -nrpo NAME,FSTYPE "$d" | awk '$2 == "xfs" { print $1; exit }')"
    [ -n "$root" ] || die "no XFS root on $d (an encrypted install cannot be read from here)"
    mnt="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap "umount -q '$mnt' 2>/dev/null || true; rmdir '$mnt' 2>/dev/null || true" EXIT
    mount -o ro,norecovery "$root" "$mnt"
    journal="$(echo "$mnt"/ostree/deploy/*/var/log/journal)"
    [ -d "$journal" ] || die "no persistent journal on $d"
    journalctl -D "$journal" --list-boots --no-pager | tail -n 5
    boot="$(journalctl -D "$journal" --list-boots --no-pager -q | tail -n 1 | awk '{ print $2 }')"
    say "the target's last boot ($boot), its last $lines lines:"
    journalctl -D "$journal" -b "$boot" --no-pager | tail -n "$lines"
    if compgen -G '/var/lib/systemd/pstore/*' >/dev/null; then
        say "kernel crash records the firmware kept (newest first):"
        ls -lt /var/lib/systemd/pstore | head -n 6
    fi
}

verb="${1:-}"
shift || true
case "$verb" in
    role) role ;;
    entries) entries "$@" ;;
    guard) guard "$@" ;;
    install) install_disk "$@" ;;
    install-loopback) install_loopback "$@" ;;
    inspect-image) inspect_image "$@" ;;
    target-entry) target_entry "$@" ;;
    controller-first) controller_first "$@" ;;
    boot-next) boot_next "$@" ;;
    reboot) reboot_soon ;;
    logs) logs "$@" ;;
    *) die "unknown verb '$verb' (see the top of metal-box.sh)" ;;
esac
