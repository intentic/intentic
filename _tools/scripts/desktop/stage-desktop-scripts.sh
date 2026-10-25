#!/usr/bin/env bash
# Recreate staged-scripts/ from git archive HEAD before bundling, so every installer gets the same committed script bytes.
# Empty it first: retained runner checkouts can contain stale, renamed or untracked scripts that must never ship.
# Uncommitted script edits do not reach local installers or tauri dev; verify-desktop-bundle.sh also compares against HEAD.
set -euo pipefail
. "$(dirname "$0")/../lib/repo-root.sh"

ROOT="$(repo_root)"
SOURCE_REL="_site/site/public/scripts"
STAGE="$ROOT/_editor/desktop-app/src-tauri/staged-scripts"

rm -rf "$STAGE"
mkdir -p "$STAGE"
# --strip-components drops the four directories of $SOURCE_REL, so the scripts land flat: the bundlers map
# `staged-scripts/*` onto `scripts/` and the app resolves them by basename (src-tauri/src/scripts.rs).
#
# --no-same-permissions under a fixed umask, because these modes are SHIPPED — the deb and the rpm carry them
# into /usr/lib/Intentic. `git archive` widens them on a checkout configured `core.sharedRepository` (664/775
# instead of 644/755), which is a property of one clone rather than of the release, and the executable bit —
# the one that would matter — survives the mask.
umask 022
git -C "$ROOT" archive HEAD "$SOURCE_REL" | tar -x --no-same-permissions -C "$STAGE" --strip-components=4

staged="$(find "$STAGE" -maxdepth 1 -type f | wc -l)"
if [ "$staged" -eq 0 ]; then
    echo "error: no scripts committed at $SOURCE_REL — the source of truth is empty, which cannot be right." >&2
    exit 1
fi
echo "==> staged $staged scripts from $SOURCE_REL ($(git -C "$ROOT" rev-parse --short HEAD))"
