#!/usr/bin/env bash
# Boot an Intentic OS image in a VM and check that it came up as Intentic OS: the boot finished, Docker runs, `ic os`
# answers, the first-boot pairing page is served on port 80, the health check runs, and the update units are in
# place. Nothing is paired: that needs a setup code from a real account.
#
#   bash _os/os-image/smoke.sh [--image REF] [--out DIR] [--keep]
#
# Needs /dev/kvm. QEMU, ssh and curl run in a Fedora container, so the host needs only docker or podman. The VM's
# disk is made by disk.sh with a throwaway root SSH key (never part of a released image), and booted with
# snapshot=on so a run leaves the disk as it was. --keep leaves the VM running afterwards (ports 18080 and 12222 on
# this machine's loopback) until the container is stopped.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="${OS_ENGINE:-$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)}"
# A command, not a name: CI runs "sudo podman", since bootc-image-builder needs a rootful podman.
read -r -a ENGINE_CMD <<< "$ENGINE"
IMAGE=ghcr.io/intentic/os:stable
OUT=""
KEEP=0
while [ $# -gt 0 ]; do
    case "$1" in
        --image) IMAGE="$2"; shift 2 ;;
        --out) OUT="$2"; shift 2 ;;
        --keep) KEEP=1; shift ;;
        -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "smoke.sh: unknown argument $1 (see --help)" >&2; exit 2 ;;
    esac
done
[ -e /dev/kvm ] || { echo "smoke.sh: needs /dev/kvm" >&2; exit 2; }
OUT="${OUT:-$HERE/out/smoke}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

# A throwaway key, and a disk that trusts it for root.
rm -f "$OUT/id_ed25519" "$OUT/id_ed25519.pub"
ssh-keygen -q -t ed25519 -N "" -C intentic-os-smoke -f "$OUT/id_ed25519"
cat > "$OUT/config.toml" <<EOF
[[customizations.user]]
name = "root"
key = "$(cat "$OUT/id_ed25519.pub")"
EOF
bash "$HERE/disk.sh" --type qcow2 --image "$IMAGE" --config "$OUT/config.toml" --out "$OUT"

RUNNER=localhost/intentic-os-smoke-runner:44
if ! "${ENGINE_CMD[@]}" image inspect "$RUNNER" >/dev/null 2>&1; then
    printf 'FROM quay.io/fedora/fedora:44\nRUN dnf -y install qemu-system-x86-core qemu-img openssh-clients curl jq && dnf clean all\n' \
        | "${ENGINE_CMD[@]}" build -t "$RUNNER" -
fi

cat > "$OUT/inside.sh" <<'EOF'
#!/bin/bash
# Runs in the runner container: boot the VM, then check it.
set -uo pipefail
cd /smoke
qemu-system-x86_64 -enable-kvm -cpu host -m 4096 -smp 2 -nographic \
    -drive file=qcow2/disk.qcow2,if=virtio,format=qcow2,snapshot=on \
    -nic user,model=virtio-net-pci,hostfwd=tcp::18080-:80,hostfwd=tcp::12222-:22 \
    -serial file:serial.log -monitor none -display none &
QEMU=$!
ssh_vm() { ssh -q -i id_ed25519 -p 12222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 root@127.0.0.1 "$@"; }

for _ in $(seq 1 120); do ssh_vm true 2>/dev/null && break; sleep 5; done
# The checks are checks.sh's, shared with metal.sh's runs on a physical machine.
/smoke/checks.sh --host 127.0.0.1 --port 12222 --key /smoke/id_ed25519 --pair-url http://127.0.0.1:18080/ --out /smoke
fail=$?

if [ "${KEEP:-0}" = 1 ]; then
    echo "smoke: the VM keeps running (http://127.0.0.1:18080, ssh -p 12222 root@127.0.0.1 -i id_ed25519)"
    wait "$QEMU"
else
    ssh_vm 'systemctl poweroff' 2>/dev/null || true
    sleep 5; kill "$QEMU" 2>/dev/null || true
fi
exit "$fail"
EOF
chmod 0755 "$OUT/inside.sh"
install -m 0755 "$HERE/checks.sh" "$OUT/checks.sh"

publish=()
if [ "$KEEP" = 1 ]; then publish=(-p 127.0.0.1:18080:18080 -p 127.0.0.1:12222:12222); fi
set +e
"${ENGINE_CMD[@]}" run --rm --device /dev/kvm -e KEEP="$KEEP" "${publish[@]}" -v "$OUT:/smoke" "$RUNNER" /smoke/inside.sh
status=$?
set -e
echo "smoke.sh: serial console in $OUT/serial.log, journal excerpt in $OUT/journal.txt"
exit "$status"
