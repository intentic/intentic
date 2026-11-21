#!/usr/bin/env bash
# One wanbench run: the server (examples/wanbench) and a headless Chrome in two network namespaces of their own joined by
# a veth pair, whose egress qdiscs are the WAN: netem (half the round trip each way, jitter, loss, in order: netem's
# `rate` keeps packets in their order) and, downstream, tbf as the bottleneck with a buffer of --buffer-ms at the cap,
# which the server changes as the run goes (--caps). Nothing outside the two namespaces is touched, so other work on
# the machine keeps its loopback. Needs CAP_NET_ADMIN and CAP_SYS_ADMIN (ip netns), tc's netem and tbf, and Chrome
# (WebCodecs wants a secure origin, which the bench's plain http address is declared to be).
#
#   run.sh --bin target/release/examples/wanbench --out /tmp/wan/lan-dc.json --mode dc|track [--rtt 100] [--jitter 10]
#          [--loss 2] [--caps 0:10000,20:3000,40:10000] [--seconds 60] [--encoder openh264] [--chrome PATH]
#          [--app-fps 57] [--buffer-ms 100]      (WARMUP=4 in the environment: seconds before measuring)
set -euo pipefail

# The app paints at 57 Hz, off the 60 Hz of capture and display, so a run samples every phase between them instead of
# locking to one.
BIN= OUT= MODE=dc RTT=0 JITTER=0 LOSS=0 CAPS= SECONDS_=60 ENCODER=openh264 BUFFER=100 SIZE=1280x720 FPS=60 APP_FPS=57
CHROME=${CHROME:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | tail -1)}
while [ $# -gt 0 ]; do
  case $1 in
    --bin) BIN=$2;; --out) OUT=$2;; --mode) MODE=$2;; --rtt) RTT=$2;; --jitter) JITTER=$2;; --loss) LOSS=$2;;
    --caps) CAPS=$2;; --seconds) SECONDS_=$2;; --encoder) ENCODER=$2;; --chrome) CHROME=$2;; --buffer-ms) BUFFER=$2;;
    --size) SIZE=$2;; --fps) FPS=$2;; --app-fps) APP_FPS=$2;;
    *) echo "unknown $1" >&2; exit 2;;
  esac
  shift 2
done
[ -x "$BIN" ] && [ -n "$OUT" ] && [ -x "$CHROME" ] || { echo "need --bin, --out and a Chrome (--chrome)" >&2; exit 2; }

ID=$$
NET=$((ID % 200 + 20))
SRV=wb-s-$ID VIEW=wb-v-$ID
SDEV=wbs$ID VDEV=wbv$ID
SIP=10.$NET.77.1 VIP=10.$NET.77.2
WORK=$(mktemp -d /tmp/wanbench.XXXXXX)
cleanup() {
  [ -n "${CPID:-}" ] && kill "$CPID" 2>/dev/null || true
  [ -n "${SPID:-}" ] && kill "$SPID" 2>/dev/null || true
  wait 2>/dev/null || true
  ip netns del "$SRV" 2>/dev/null || true
  ip netns del "$VIEW" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

ip netns add "$SRV"
ip netns add "$VIEW"
ip link add "$SDEV" type veth peer name "$VDEV"
ip link set "$SDEV" netns "$SRV"
ip link set "$VDEV" netns "$VIEW"
ip -n "$SRV" addr add "$SIP/24" dev "$SDEV"
ip -n "$VIEW" addr add "$VIP/24" dev "$VDEV"
for ns in "$SRV" "$VIEW"; do ip -n "$ns" link set lo up; done
ip -n "$SRV" link set "$SDEV" up
ip -n "$VIEW" link set "$VDEV" up

# Half the round trip and half the jitter each way; the loss on each.
half() { awk -v v="$1" 'BEGIN { printf "%.1f", v / 2 }'; }
NETEM=(delay "$(half "$RTT")ms" "$(half "$JITTER")ms" loss "$LOSS%" rate 1000mbit limit 100000)
if [ "$RTT" != 0 ] || [ "$LOSS" != 0 ] || [ -n "$CAPS" ]; then
  ip netns exec "$SRV" tc qdisc add dev "$SDEV" root handle 1: netem "${NETEM[@]}"
  ip netns exec "$VIEW" tc qdisc add dev "$VDEV" root handle 1: netem "${NETEM[@]}"
  if [ -n "$CAPS" ]; then
    # Replaced by the server's first --caps step at once.
    ip netns exec "$SRV" tc qdisc add dev "$SDEV" parent 1:1 handle 10: tbf rate 100mbit burst 100000 limit 1000000
  fi
fi

ARGS=(--listen "$SIP:8080" --rtc "$SIP:0" --out "$OUT" --mode "$MODE" --seconds "$SECONDS_" --warmup "${WARMUP:-4}" --encoder "$ENCODER" --size "$SIZE" --fps "$FPS" --app-fps "$APP_FPS")
[ -n "$CAPS" ] && ARGS+=(--dev "$SDEV" --caps "$CAPS" --buffer-ms "$BUFFER")
ip netns exec "$SRV" "$BIN" "${ARGS[@]}" >"$WORK/server.out" 2>"$WORK/server.log" &
SPID=$!
for _ in $(seq 100); do grep -q READY "$WORK/server.out" 2>/dev/null && break; sleep 0.1; done
grep -q READY "$WORK/server.out" || { cat "$WORK/server.log" >&2; exit 1; }

ip netns exec "$VIEW" "$CHROME" --headless=new --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check \
  --disable-background-networking --disable-component-update --mute-audio --autoplay-policy=no-user-gesture-required \
  --window-size=1300,760 --user-data-dir="$WORK/profile" --enable-logging=stderr --v=0 \
  --unsafely-treat-insecure-origin-as-secure="http://$SIP:8080" "http://$SIP:8080/" >"$WORK/chrome.log" 2>&1 &
CPID=$!

if ! wait "$SPID"; then
  echo "server failed" >&2
  tail -30 "$WORK/server.log" >&2
  grep -a wanbench "$WORK/chrome.log" | tail -20 >&2 || true
  exit 1
fi
SPID=
# What the page and the server said, for the run's log (matrix.sh keeps it beside the report).
grep -a -E "wanbench|CONSOLE" "$WORK/chrome.log" | tail -15 >&2 || true
grep -E "WARN|ERROR|rtc:|viewer" "$WORK/server.log" | tail -60 >&2 || true
