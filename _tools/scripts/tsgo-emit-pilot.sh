#!/usr/bin/env bash
# tsgo emit pilot — does @typescript/native-preview (tsgo, TS7) emit the same dist/ as tsc for a leaf package?
#
# The Tier-1 migration (api, site-content) only uses `tsgo --noEmit`. Before trusting tsgo for the ~28 packages
# that EMIT publishable dist/ + .d.ts, this script proves the emit is equivalent on one true leaf. It runs BOTH
# compilers over the SAME tsconfig, diffs the emitted dist/, then rebuilds dist/ with tsc so the tree is left
# exactly as the canonical build produces it (non-destructive).
#
#   bash _tools/scripts/tsgo-emit-pilot.sh [package-dir]   # default: _deploy/graph (a true leaf — only tslib)
#
# Exit 0 = byte-identical emit; exit 1 = differences (printed) or a compiler failure. Full diff: /tmp/tsgo-emit-pilot.diff
set -euo pipefail

PKG="${1:-_deploy/graph}"
. "$(dirname "$0")/repo-root.sh"
ROOT="$(repo_root)"
cd "$ROOT"

TSCONFIG="$PKG/tsconfig.json"
[ -f "$TSCONFIG" ] || { echo "no tsconfig at $TSCONFIG"; exit 1; }

WORK="$(mktemp -d)"
DIFF_OUT="/tmp/tsgo-emit-pilot.diff"
trap 'rm -rf "$WORK"' EXIT

emit() { # $1 = tsc|tsgo -> emit into PKG/dist, snapshot to $WORK/$1
  rm -rf "$PKG/dist" "$PKG/.cache"
  echo ">> $1 -p $TSCONFIG"
  pnpm exec "$1" -p "$TSCONFIG" || return 1
  cp -r "$PKG/dist" "$WORK/$1"
}

echo "== tsgo emit pilot: $PKG =="
emit tsc || { echo "tsc baseline FAILED — aborting"; exit 1; }
TSGO_OK=1; emit tsgo || TSGO_OK=0

status=0
if [ "$TSGO_OK" -eq 1 ]; then
  echo
  echo "== emitted file set (< only tsc, > only tsgo) =="
  diff <(cd "$WORK/tsc" && find . -type f | sort) <(cd "$WORK/tsgo" && find . -type f | sort) \
    && echo "  identical file set" || echo "  ^ file set differs"
  echo
  echo "== content diff (a=tsc  b=tsgo) =="
  if diff -ruN "$WORK/tsc" "$WORK/tsgo" >"$DIFF_OUT" 2>&1; then
    echo "IDENTICAL EMIT — tsgo matches tsc byte-for-byte for $PKG"
  else
    status=1
    echo "emit DIFFERS — summary:"
    diff -rqN "$WORK/tsc" "$WORK/tsgo" || true
    echo
    echo "first 120 lines (full copy: $DIFF_OUT):"
    head -120 "$DIFF_OUT"
  fi
else
  status=1
  echo "tsgo did NOT emit — declaration/composite emit may be unsupported in this tsgo build."
fi

echo
echo "== restoring canonical tsc build for $PKG =="
rm -rf "$PKG/dist" "$PKG/.cache"
pnpm exec tsc -p "$TSCONFIG" >/dev/null
echo "done — dist/ restored via tsc."
exit $status
