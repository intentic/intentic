#!/usr/bin/env bash
# Run the installer ISO end to end in a VM with a software TPM2 and UEFI Secure Boot, then boot what it installed:
#
#   bash _os/os-image/install-test.sh [--image REF] [--out DIR] [--iso PATH]
#
# Checks that the unattended install finishes, that the installed system boots to a login prompt by itself (the TPM
# unlocked its root: nobody typed a passphrase), that it serves its pairing page, and, reading the disk from outside,
# that the root is LUKS2 holding only the TPM's slot and a recovery key (intentic-tpm-enroll's work on that first
# boot). The screen is saved as PNGs in DIR for a person to look at.
# --iso reuses an ISO already built; otherwise disk.sh builds one from --image (default ghcr.io/intentic/os:stable).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="${OS_ENGINE:-$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)}"
# A command, not a name: CI runs "sudo podman", since bootc-image-builder needs a rootful podman.
read -r -a ENGINE_CMD <<< "$ENGINE"
IMAGE=ghcr.io/intentic/os:stable
OUT=""
ISO=""
while [ $# -gt 0 ]; do
    case "$1" in
        --image) IMAGE="$2"; shift 2 ;;
        --out) OUT="$2"; shift 2 ;;
        --iso) ISO="$2"; shift 2 ;;
        -h | --help) sed -n '2,10p' "$0"; exit 0 ;;
        *) echo "install-test.sh: unknown argument $1 (see --help)" >&2; exit 2 ;;
    esac
done
[ -e /dev/kvm ] || { echo "install-test.sh: needs /dev/kvm" >&2; exit 2; }
OUT="${OUT:-$HERE/out/install-test}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

if [ -z "$ISO" ]; then
    bash "$HERE/disk.sh" --type anaconda-iso --image "$IMAGE" --out "$OUT"
    ISO="$OUT/bootiso/install.iso"
fi
[ "$ISO" -ef "$OUT/install.iso" ] || cp "$ISO" "$OUT/install.iso"

RUNNER=localhost/intentic-os-install-runner:44
if ! "${ENGINE_CMD[@]}" image inspect "$RUNNER" >/dev/null 2>&1; then
    printf 'FROM quay.io/fedora/fedora:44\nRUN dnf -y install qemu-system-x86-core qemu-img edk2-ovmf swtpm swtpm-tools python3 && dnf clean all\n' \
        | "${ENGINE_CMD[@]}" build -t "$RUNNER" -
fi

cat > "$OUT/inside.sh" <<'EOF'
#!/bin/bash
# Runs in the runner container.
set -uo pipefail
cd /t
rm -f disk.qcow2 vars.fd serial-*.log screen-*.ppm screen-*.png
rm -rf tpm && mkdir tpm
qemu-img create -q -f qcow2 disk.qcow2 40G
cp /usr/share/edk2/ovmf/OVMF_VARS.secboot.fd vars.fd
fail=0
check() { if "$@"; then echo "PASS  $name"; else echo "FAIL  $name"; fail=1; fi; }

vm() {
    # $1 serial log, rest extra args. The same firmware, TPM and disk both times, as one machine.
    local log="$1"; shift
    # A TPM process per boot over the same state directory: swtpm ends when the VM that used it shuts down.
    rm -f tpm/sock
    swtpm socket --tpm2 --tpmstate dir=tpm --ctrl type=unixio,path=tpm/sock --daemon
    for _ in $(seq 1 20); do [ -S tpm/sock ] && break; sleep 0.5; done
    qemu-system-x86_64 -enable-kvm -cpu host -m 4096 -smp 2 -machine q35,smm=on \
        -global driver=cfi.pflash01,property=secure,value=on \
        -drive if=pflash,format=raw,unit=0,file=/usr/share/edk2/ovmf/OVMF_CODE.secboot.fd,readonly=on \
        -drive if=pflash,format=raw,unit=1,file=vars.fd \
        -chardev socket,id=tpm,path=tpm/sock -tpmdev emulator,id=tpm0,chardev=tpm -device tpm-tis,tpmdev=tpm0 \
        -drive file=disk.qcow2,if=virtio,format=qcow2 \
        -nic user,model=virtio-net-pci,hostfwd=tcp::18080-:80 \
        -vga std -display none -serial "file:$log" -monitor pipe:mon -no-reboot "$@" &
    QEMU=$!
    cat mon.out > /dev/null &
}
# Never a bare write: a fifo nobody reads (QEMU gone) blocks the writer for good.
shot() { kill -0 "$QEMU" 2>/dev/null && timeout 5 sh -c "echo screendump screen-$1.ppm > mon.in"; sleep 2; }
mkfifo mon.in mon.out 2>/dev/null

# 1. The install, from the ISO. -no-reboot: the kickstart's reboot ends QEMU, which is how the install is seen to finish.
vm serial-install.log -cdrom install.iso -boot d
for i in $(seq 1 270); do kill -0 "$QEMU" 2>/dev/null || break; sleep 10; [ $((i % 30)) -eq 0 ] && shot "install-$i"; done
name="the unattended install finishes"; check test "$i" -lt 270
kill "$QEMU" 2>/dev/null; wait "$QEMU" 2>/dev/null

# 2. The first boot of what was installed.
vm serial-boot.log
for i in $(seq 1 60); do grep -aq "login:" serial-boot.log && break; sleep 5; done
name="the installed system boots to a login prompt without a passphrase"; check grep -aq "login:" serial-boot.log
sleep 20; shot boot-recovery-key
for i in $(seq 1 24); do curl -fsS -o pair.html http://127.0.0.1:18080/ 2>/dev/null && break; sleep 5; done
name="the pairing page is served"; check grep -qi "setup code" pair.html
kill "$QEMU" 2>/dev/null; wait "$QEMU" 2>/dev/null

# 3. The disk, read from outside: its largest GPT partition holds LUKS2 with two keyslots, the TPM's and the recovery
# key, and the installer's one-time passphrase gone.
qemu-img convert -O raw disk.qcow2 disk.raw
python3 - disk.raw > luks.txt <<'PY'
import json, struct, sys
raw = open(sys.argv[1], "rb")
raw.seek(512)
header = raw.read(92)
if header[:8] != b"EFI PART":
    print("no-gpt"); sys.exit(0)
entries_lba, count, size = struct.unpack_from("<QII", header, 72)
raw.seek(entries_lba * 512)
parts = []
for _ in range(count):
    entry = raw.read(size)
    first, last = struct.unpack_from("<QQ", entry, 32)
    if first:
        parts.append((last - first, first))
raw.seek(max(parts)[1] * 512)
luks = raw.read(4096)
if luks[:6] != b"LUKS\xba\xbe":
    print("not-luks"); sys.exit(0)
meta = json.loads(raw.read(struct.unpack_from(">Q", luks, 8)[0] - 4096).rstrip(b"\0"))
print("luks2 keyslots=%d tokens=%s" % (len(meta["keyslots"]), ",".join(sorted(t["type"] for t in meta["tokens"].values()))))
PY
rm -f disk.raw
echo "      disk: $(cat luks.txt)"
name="the root is LUKS2 with only the TPM's slot and a recovery key"; check grep -qx "luks2 keyslots=2 tokens=systemd-recovery,systemd-tpm2" luks.txt

# The screens, as PNG for a person (and an agent) to look at.
python3 - <<'PY'
import glob, struct, zlib
for path in sorted(glob.glob("screen-*.ppm")):
    data = open(path, "rb").read()
    parts = data.split(b"\n", 3)
    width, height = map(int, parts[1].split())
    pixels = parts[3]
    rows = b"".join(b"\x00" + pixels[y * width * 3:(y + 1) * width * 3] for y in range(height))
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) \
        + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b"")
    open(path[:-4] + ".png", "wb").write(png)
PY
exit "$fail"
EOF
chmod 0755 "$OUT/inside.sh"
set +e
"${ENGINE_CMD[@]}" run --rm --device /dev/kvm -v "$OUT:/t" "$RUNNER" /t/inside.sh
status=$?
set -e
echo "install-test.sh: serial logs, screens (screen-*.png) and the ISO are in $OUT"
exit "$status"
