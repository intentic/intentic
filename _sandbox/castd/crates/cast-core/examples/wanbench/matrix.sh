#!/usr/bin/env bash
# The README's matrix: an unimpaired link, then every round trip (40, 100, 200 ms, jitter a tenth of it) with every loss
# (0.5, 2, 5 % each way), the downstream capped at 10 Mbit/s, dropped to 3 Mbit/s a third of the way in and raised back
# at two thirds. One run.sh each, one report each in --dir, analyze.mjs over them at the end.
#
#   matrix.sh --bin target/release/examples/wanbench --dir /tmp/wan/baseline --mode dc|track [--seconds 45] [--only rtt100-l2]
#             [--keyframes 16,31]   (the page asks for a keyframe at those seconds, as a decoder that lost the stream would)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BIN= DIR= MODE=dc SECONDS_=45 ONLY= ENCODER=openh264 KEYFRAMES=
while [ $# -gt 0 ]; do
  case $1 in
    --bin) BIN=$2;; --dir) DIR=$2;; --mode) MODE=$2;; --seconds) SECONDS_=$2;; --only) ONLY=$2;; --encoder) ENCODER=$2;; --keyframes) KEYFRAMES=$2;;
    *) echo "unknown $1" >&2; exit 2;;
  esac
  shift 2
done
mkdir -p "$DIR"
third=$((SECONDS_ / 3))
CAPS="0:10000,$third:3000,$((2 * third)):10000"
profiles=(lan)
for rtt in 40 100 200; do for loss in 0.5 2 5; do profiles+=("rtt$rtt-l$loss"); done; done
for p in "${profiles[@]}"; do
  [ -n "$ONLY" ] && [[ ",$ONLY," != *",$p,"* ]] && continue
  if [ "$p" = lan ]; then
    args=()
  else
    rtt=${p#rtt}; rtt=${rtt%%-*}; loss=${p#*-l}
    args=(--rtt "$rtt" --jitter "$((rtt / 10))" --loss "$loss" --caps "$CAPS")
  fi
  [ -n "$KEYFRAMES" ] && args+=(--keyframes "$KEYFRAMES")
  echo "== $p $MODE" >&2
  "$HERE/run.sh" --bin "$BIN" --out "$DIR/$p-$MODE.json" --mode "$MODE" --seconds "$SECONDS_" --encoder "$ENCODER" "${args[@]}" \
    >"$DIR/$p-$MODE.log" 2>&1 || echo "   failed: $DIR/$p-$MODE.log" >&2
done
node "$HERE/analyze.mjs" "$DIR"/*-"$MODE".json
