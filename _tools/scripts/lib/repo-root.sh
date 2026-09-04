#!/usr/bin/env bash
# The monorepo root, FOUND rather than counted — the shell half of @intentic/constants/node's repoRoot().
#
# Every maintainer script used to spell its own way home: `cd "$(dirname "$0")/../.."`, `ROOT="$(cd
# "$(dirname "$0")/../.." && pwd)"`, sometimes four levels for the ones that ship elsewhere. The count is right
# only for the script's current location, and nothing checks it — move a script one directory and it silently
# cd's somewhere else, which in a release script means publishing from the wrong tree.
#
# Walking up until pnpm-workspace.yaml appears has no such coupling. Source this and call `repo_root`:
#
#   . "$(dirname "$0")/../lib/repo-root.sh"
#   cd "$(repo_root)"
#
# THE ONE RELATIVE PATH LEFT IS THAT `../lib/`, and it is a claim about the layout of `_tools/scripts` — every
# runnable script sits one level down, in its family directory, and the shared ones sit in `lib/` beside them.
# That is a much smaller claim than the counted ones above: it does not depend on how deep this directory sits
# in the repository, only on the shape of this directory, which moves as a unit. It is also a LOUD claim —
# breaking it fails at the `.` line, before any script body runs, rather than silently pointing somewhere
# plausible. `_tools/checks/path-literals.mjs` is what keeps the counted spellings from coming back.

# RESOLVED AT SOURCE TIME, not at call time. `$0` is usually RELATIVE to the directory the script was invoked
# from, so a script that cd's before calling repo_root would have it resolve against the new location — which
# is precisely the class of bug this file exists to remove. Snapshotting here means the answer is fixed before
# any script body runs. `$0` is the SOURCING script under both bash and sh (sourcing does not rebind it), so
# this is that script's own directory.
_REPO_ROOT_FROM="$(cd "$(dirname "$0")" 2>/dev/null && pwd || printf '%s' "$PWD")"

repo_root() {
    _dir="$_REPO_ROOT_FROM"
    while [ "$_dir" != "/" ] && [ -n "$_dir" ]; do
        if [ -f "$_dir/pnpm-workspace.yaml" ]; then
            printf '%s\n' "$_dir"
            return 0
        fi
        _dir="$(dirname "$_dir")"
    done
    echo "repo-root.sh: no pnpm-workspace.yaml above $_REPO_ROOT_FROM — is this a complete checkout?" >&2
    return 1
}
