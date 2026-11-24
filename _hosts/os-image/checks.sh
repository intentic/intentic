#!/usr/bin/env bash
# The checks a booted Intentic OS must pass, run over SSH as root: smoke.sh runs them against its VM, metal.sh against
# a test machine on the local network. One line per check (PASS, FAIL or SKIP); exits 1 when any failed.
#
#   checks.sh --host HOST [--port 22] --key FILE --pair-url URL [--out DIR] [--image REF] [--digest SHA] [--kata]
#
# --out keeps what the checks read: the system state, the pairing page, `ic os status`, a journal excerpt.
# --image and --digest also check that the machine booted that image. --kata runs a container in a Kata microVM and
# checks it got a kernel of its own; it needs /dev/kvm on the machine, so it is for bare metal, not a nested VM.
# A machine that is paired already skips the pairing checks: its pairing unit stops for good once it has paired.
# Needs ssh and curl here; jq runs on the machine.
set -uo pipefail
HOST=""
PORT=22
KEY=""
PAIR_URL=""
OUT=""
IMAGE=""
DIGEST=""
KATA=0
while [ $# -gt 0 ]; do
    case "$1" in
        --host) HOST="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --key) KEY="$2"; shift 2 ;;
        --pair-url) PAIR_URL="$2"; shift 2 ;;
        --out) OUT="$2"; shift 2 ;;
        --image) IMAGE="$2"; shift 2 ;;
        --digest) DIGEST="$2"; shift 2 ;;
        --kata) KATA=1; shift ;;
        -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
        *) echo "checks.sh: unknown argument $1 (see --help)" >&2; exit 2 ;;
    esac
done
[ -n "$HOST" ] && [ -n "$KEY" ] && [ -n "$PAIR_URL" ] || { echo "checks.sh: --host, --key and --pair-url are required" >&2; exit 2; }
OUT="${OUT:-$(mktemp -d)}"
mkdir -p "$OUT"

# A test machine's host key changes with every install, so it is not pinned.
on_box() {
    ssh -q -i "$KEY" -p "$PORT" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 "root@$HOST" "$@"
}
fail=0
check() {
    local name="$1"; shift
    if "$@"; then echo "PASS  $name"; else echo "FAIL  $name"; fail=1; fi
}
skip() { echo "SKIP  $1 ($2)"; }

check "the machine answers ssh" on_box true
on_box 'systemctl is-system-running --wait' > "$OUT/state.txt" 2>&1 || true
echo "      system state: $(cat "$OUT/state.txt")"
check "docker runs" on_box 'systemctl is-active --quiet docker && docker info --format "{{.ServerVersion}}" >/dev/null'
check "kata is a Docker runtime" on_box 'docker info --format "{{json .Runtimes}}" | grep -q kata'
check "the containerd image store is on" on_box '[ "$(docker info --format "{{.Driver}}")" = overlayfs ]'
check "release.json names Intentic OS" on_box 'jq -e ".name == \"Intentic OS\"" /usr/lib/intentic-os/release.json >/dev/null'
check "the intentic user exists, in docker, lingering" on_box 'id intentic | grep -q docker && test -e /var/lib/systemd/linger/intentic'
check "bootc's auto-reboot timer is masked" on_box '[ "$(systemctl is-enabled bootc-fetch-apply-updates.timer 2>&1)" = masked ]'
check "the staging timer is armed" on_box 'systemctl is-active --quiet intentic-os-update.timer'
if on_box 'test -e /var/lib/intentic-os/paired'; then
    skip "the pairing unit runs" "paired already"
    skip "the pairing page is served on port 80" "paired already"
else
    check "the pairing unit runs" on_box 'systemctl is-active --quiet intentic-pair.service'
    rm -f "$OUT/pair.html"
    for _ in $(seq 1 24); do curl -fsS -o "$OUT/pair.html" "$PAIR_URL" 2>/dev/null && break; sleep 5; done
    check "the pairing page is served on port 80" grep -qi "setup code" "$OUT/pair.html"
fi
check "ic os status answers as the intentic user" on_box 'su -s /bin/sh intentic -c "ic os status --json" | jq -e ".os == \"intentic-os\" and .booted != null" >/dev/null'
check "ic os health is green" on_box 'ic os health --wait 120'
check "greenboot ran this boot's checks" on_box 'systemctl is-active --quiet greenboot-healthcheck.service || systemctl show -p Result greenboot-healthcheck.service | grep -q success'
if [ -n "$IMAGE" ]; then
    check "the machine booted $IMAGE" on_box "bootc status --json | jq -e --arg ref '$IMAGE' '.status.booted.image.image.image == \$ref' >/dev/null"
fi
if [ -n "$DIGEST" ]; then
    check "the booted image is $DIGEST" on_box "bootc status --json | jq -e --arg d '$DIGEST' '.status.booted.image.imageDigest == \$d' >/dev/null"
fi
if [ "$KATA" = 1 ]; then
    if on_box 'test -e /dev/kvm'; then
        # A microVM boots a kernel of its own; runc would answer with the machine's. A guest that cannot boot (nested
        # virtualization) hangs rather than fails, and docker run hands a plain SIGTERM on to it and waits: hence the
        # deadline with a KILL after it, and the container removed whichever way.
        check "a container runs in a Kata microVM" on_box \
            'timeout 60 docker rm -f intentic-check-kata >/dev/null 2>&1
             guest="$(timeout -k 10 180 docker run --rm --name intentic-check-kata --runtime kata busybox uname -r)"; ok=$?
             timeout 60 docker rm -f intentic-check-kata >/dev/null 2>&1
             [ "$ok" = 0 ] && [ -n "$guest" ] && [ "$guest" != "$(uname -r)" ]'
    else
        skip "a container runs in a Kata microVM" "no /dev/kvm on the machine: virtualization is off in its firmware"
    fi
fi
on_box 'ic os status --json' > "$OUT/status.json" 2>&1 || true
on_box 'journalctl -b --no-pager -u intentic-pair -u greenboot-healthcheck -u docker -u kata-osbuilder-generate | tail -n 80' \
    > "$OUT/journal.txt" 2>&1 || true
exit "$fail"
