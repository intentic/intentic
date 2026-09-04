#!/usr/bin/env bash
# Put the launcher scripts the desktop app spawns where the bundlers can see them — copied FROM THE COMMIT,
# not read from `_site/site/public/scripts/` as it happens to sit on disk.
#
#   stage-desktop-scripts.sh          # → _editor/desktop-app/src-tauri/staged-scripts/
#
# WHY A STAGING STEP AT ALL. `tauri.conf.json` used to glob the site directory directly, which made the
# bundled set whatever the WORKING TREE held at the moment each bundler ran. The runners keep their checkout
# between jobs (`clean: false`, docs/ci-runner.md), so that directory can hold a file the commit does not
# carry — and every one of them shipped, inside an installer, as a script the app spawns by basename and
# nobody can review at its source path. That is not hypothetical: release 1.206.0's windows-build died at
# verify-desktop-bundle.sh with `stale connect-host.ps1 is bundled but is not committed`, on a checkout that
# had built three green jobs an hour earlier. The tree also MOVES mid-build — job 92707727494 packed a .deb
# and a .rpm two seconds apart from two different versions of cleanup.sh.
#
# So the glob now points here, and this directory is rebuilt from `git archive HEAD` on the way in. What ships
# is what the commit says, for every bundler in the run, and verify-desktop-bundle.sh — which has always
# asserted against the commit — is checking a property the build now guarantees rather than hoping for.
#
# Emptied and refilled rather than synced: a rename or a deletion has to disappear from the bundle, and a
# staging directory that only ever gains files is the same stale-tree bug one level in.
#
# The cost, stated plainly: an UNCOMMITTED edit to a script does not reach a locally built installer or
# `tauri dev`. Commit it — that is the same bar verify-desktop-bundle.sh has always held builds to, now
# enforced early instead of at the end of a six-minute bundle.
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
